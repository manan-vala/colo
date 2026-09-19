import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { SETTINGS_KEYS, SETTINGS_MAP } from "../shared/doc-schema";
import { CLOSE_CODES, LIMITS, type ControlEvent } from "../shared/protocol";
import { DOCUMENT_MIGRATIONS, migrate } from "./db";
import { IDENTITY_HEADER, INTERNAL_HOST, decodeIdentity, type DocumentIdentity } from "./documents";
import {
  clearPendingMeta,
  readPendingMeta,
  readState,
  writePendingMeta,
  writeState,
  type PendingMeta,
} from "./storage";

const META_PUSH_INTERVAL = 60_000;

export interface ConnectionState {
  identity: DocumentIdentity;
  /** Token bucket for incoming messages; lives in the socket attachment so it survives hibernation. */
  tokens: number;
  refilledAt: number;
}

/** Refills the bucket for the elapsed time and takes one token; returns null when empty. */
export function takeToken(bucket: { tokens: number; refilledAt: number }, now: number) {
  const tokens = Math.min(
    LIMITS.messageBurst,
    bucket.tokens + (Math.max(0, now - bucket.refilledAt) / 1000) * LIMITS.messagesPerSecond,
  );
  return tokens < 1 ? null : { tokens: tokens - 1, refilledAt: now };
}

/**
 * One Document Durable Object per document (plan §2.1): the live Yjs document and its
 * hibernating WebSockets via y-partyserver, with the whole Yjs state saved to SQLite on a
 * debounce (one row per save for documents under 1.9 MB).
 */
export class Document extends YServer<Env> {
  static options = { hibernate: true };
  static callbackOptions = { debounceWait: 2000, debounceMaxWait: 10_000 };

  private readOnly = false;

  // Document-list metadata not yet sent to Workspace. In memory while the object is awake; a
  // deferred update is also written to `pending_meta`, so eviction before the alarm loses nothing.
  private metaDirty = false;
  private titleChanged = false;
  private lastEditor: string | null = null;
  private lastEditAt: string | null = null;
  private lastMetaPush = 0;
  private persistedMeta: PendingMeta | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrate(ctx.storage, DOCUMENT_MIGRATIONS);
    });
  }

  // ---- persistence -----------------------------------------------------------

  async onLoad(): Promise<void> {
    const { sql } = this.ctx.storage;
    const state = readState(sql);
    if (state) {
      Y.applyUpdate(this.document, state);
      this.readOnly = state.byteLength > LIMITS.docStateBytes;
    }
    const pending = readPendingMeta(sql);
    if (pending) {
      this.metaDirty = true;
      this.lastEditor = pending.updatedBy;
      this.lastEditAt = pending.updatedAt;
      this.persistedMeta = pending;
    }
    // One line per cold start or wake from hibernation; used to verify hibernation (plan §9.2).
    console.log(JSON.stringify({ event: "document-load", doc: this.name, bytes: state?.byteLength ?? 0 }));

    this.document.on("update", (_update: Uint8Array, origin: unknown) => {
      const identity = (origin as Connection<ConnectionState> | null)?.state?.identity;
      if (identity) this.lastEditor = identity.memberId;
      this.lastEditAt = new Date().toISOString();
      this.metaDirty = true;
    });
    this.document.getMap(SETTINGS_MAP).observe((event) => {
      if (event.keysChanged.has(SETTINGS_KEYS.title)) this.titleChanged = true;
    });
  }

  async onSave(): Promise<void> {
    const state = Y.encodeStateAsUpdate(this.document);
    writeState(this.ctx.storage, state);

    const tooLarge = state.byteLength > LIMITS.docStateBytes;
    if (tooLarge && !this.readOnly) this.broadcastControl({ type: "limit", code: "DOCUMENT_TOO_LARGE" });
    this.readOnly = tooLarge;
    this.broadcastControl({ type: "saved", at: new Date().toISOString() });
    await this.pushMeta();
  }

  isReadOnly(): boolean {
    return this.readOnly;
  }

  /**
   * Tells Workspace the title and last edit: at most once a minute for ordinary edits
   * (plan §9.3), but right away when the title changed so the document list stays current.
   */
  private async pushMeta(): Promise<void> {
    if (!this.metaDirty) return;
    const now = Date.now();
    if (!this.titleChanged && now - this.lastMetaPush < META_PUSH_INTERVAL) {
      await this.deferMeta(this.lastMetaPush + META_PUSH_INTERVAL);
      return;
    }
    this.metaDirty = false;
    this.titleChanged = false;
    this.lastMetaPush = now;
    const title = this.document.getMap(SETTINGS_MAP).get(SETTINGS_KEYS.title);
    try {
      await this.env.WORKSPACE.getByName("default").updateDocumentMeta(this.name, {
        title: typeof title === "string" && title.trim() ? title : null,
        updatedAt: this.lastEditAt ?? new Date(now).toISOString(),
        updatedBy: this.lastEditor,
      });
      if (this.persistedMeta) {
        clearPendingMeta(this.ctx.storage.sql);
        this.persistedMeta = null;
      }
    } catch (error) {
      this.metaDirty = true;
      console.error("metadata push failed", error);
      await this.deferMeta(now + META_PUSH_INTERVAL);
    }
  }

  /**
   * Schedules the alarm that sends a throttled update and records the update in SQLite. The row
   * is rewritten only when the editor changes, so a minute of typing costs about three rows
   * (this write, the alarm and the delete after sending) rather than one per save.
   */
  private async deferMeta(at: number): Promise<void> {
    const meta: PendingMeta = { updatedAt: this.lastEditAt ?? new Date().toISOString(), updatedBy: this.lastEditor };
    if (!this.persistedMeta || this.persistedMeta.updatedBy !== meta.updatedBy) {
      writePendingMeta(this.ctx.storage.sql, meta);
      this.persistedMeta = meta;
    }
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(at);
  }

  async onAlarm(): Promise<void> {
    await this.pushMeta();
  }

  // ---- connections -----------------------------------------------------------

  getConnectionTags(_connection: Connection, ctx: ConnectionContext): string[] {
    const identity = decodeIdentity(ctx.request.headers.get(IDENTITY_HEADER));
    return identity ? [`session:${identity.sessionHash}`, `member:${identity.memberId}`] : [];
  }

  onConnect(connection: Connection<ConnectionState>, ctx: ConnectionContext): void {
    const identity = decodeIdentity(ctx.request.headers.get(IDENTITY_HEADER));
    if (!identity) {
      connection.close(CLOSE_CODES.unauthorized, "unauthorized");
      return;
    }
    connection.setState({ identity, tokens: LIMITS.messageBurst, refilledAt: Date.now() });
    super.onConnect(connection, ctx);
  }

  onMessage(connection: Connection<ConnectionState>, message: WSMessage): void {
    const state = connection.state;
    if (!state) {
      connection.close(CLOSE_CODES.unauthorized, "unauthorized");
      return;
    }
    const now = Date.now();
    if (Date.parse(state.identity.sessionExpiresAt) <= now) {
      this.sendControl(connection, { type: "session-expired" });
      connection.close(CLOSE_CODES.sessionExpired, "session expired");
      return;
    }
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (size > LIMITS.messageBytes) {
      this.sendControl(connection, { type: "limit", code: "MESSAGE_TOO_LARGE" });
      connection.close(CLOSE_CODES.messageTooLarge, "message too large");
      return;
    }
    const bucket = takeToken(state, now);
    if (!bucket) {
      // Closing (instead of dropping) makes the client reconnect with backoff and re-sync,
      // so no edit is silently lost.
      this.sendControl(connection, { type: "limit", code: "RATE_LIMITED" });
      connection.close(CLOSE_CODES.rateLimited, "rate limited");
      return;
    }
    connection.setState({ identity: state.identity, ...bucket });
    super.onMessage(connection, message);
  }

  // ---- internal requests from Workspace ---------------------------------------

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.hostname !== INTERNAL_HOST || request.method !== "POST") {
      return Response.json({ error: "NOT_FOUND" }, { status: 404 });
    }
    const body = (await request.json()) as Record<string, unknown>;
    switch (url.pathname) {
      case "/title": {
        const title = String(body.title ?? "");
        this.document.transact(() => this.document.getMap(SETTINGS_MAP).set(SETTINGS_KEYS.title, title));
        return Response.json({ ok: true });
      }
      case "/close-session": {
        for (const connection of this.getConnections(`session:${String(body.sessionHash)}`)) {
          this.sendControl(connection, { type: "session-expired" });
          connection.close(CLOSE_CODES.sessionExpired, "signed out");
        }
        return Response.json({ ok: true });
      }
      case "/delete": {
        for (const connection of this.getConnections()) {
          this.sendControl(connection, { type: "document-deleted" });
          connection.close(CLOSE_CODES.documentDeleted, "document deleted");
        }
        return Response.json({ ok: true });
      }
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }

  private sendControl(connection: Connection, event: ControlEvent) {
    this.sendCustomMessage(connection, JSON.stringify(event));
  }

  private broadcastControl(event: ControlEvent) {
    this.broadcastCustomMessage(JSON.stringify(event));
  }
}
