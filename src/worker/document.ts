import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import * as Y from "yjs";
import { SETTINGS_KEYS, SETTINGS_MAP } from "../shared/doc-schema";
import {
  CLOSE_CODES,
  LIMITS,
  isUlid,
  type ControlEvent,
  type CreateRestorePointRequest,
  type ListRestorePointsResponse,
  type RestoreResponse,
} from "../shared/protocol";
import { DOCUMENT_MIGRATIONS, migrate } from "./db";
import { IDENTITY_HEADER, INTERNAL_HOST, decodeIdentity, type DocumentIdentity } from "./documents";
import { HttpError, errorResponse, json, readJson } from "./http";
import { serveImage, uploadImage } from "./images";
import {
  AUTO_POINT_INTERVAL,
  createPoint,
  getPoint,
  isEmptyState,
  latestPointAt,
  listPoints,
  readPointState,
  replaceState,
  type NewPoint,
} from "./restore-points";
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
  /** When the newest restore point was taken (ms); decides when the next automatic one is due. */
  private lastPointAt = 0;

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
    this.lastPointAt = latestPointAt(sql);
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
    this.takeAutomaticPoint();
    const state = Y.encodeStateAsUpdate(this.document);
    writeState(this.ctx.storage, state);

    const tooLarge = state.byteLength > LIMITS.docStateBytes;
    if (tooLarge && !this.readOnly) this.broadcastControl({ type: "limit", code: "DOCUMENT_TOO_LARGE" });
    this.readOnly = tooLarge;
    this.broadcastControl({ type: "saved", at: new Date().toISOString() });
    await this.pushMeta();
  }

  /**
   * Before a save, at most every 30 minutes: the state saved last time becomes an automatic
   * restore point. Each one is the document as it stood before a stretch of editing began.
   * About two rows per 30 minutes of editing (plan §9.2).
   */
  private takeAutomaticPoint() {
    if (Date.now() - this.lastPointAt < AUTO_POINT_INTERVAL) return;
    const previous = readState(this.ctx.storage.sql);
    if (!previous || isEmptyState(previous)) return;
    this.savePoint({ kind: "auto", state: previous });
  }

  private savePoint(point: NewPoint) {
    const saved = createPoint(this.ctx.storage, point);
    this.lastPointAt = Date.parse(saved.createdAt);
    return saved;
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

  // ---- HTTP requests ------------------------------------------------------------

  /**
   * Two kinds of request reach the object: internal ones from Workspace (rename, sign-out,
   * delete) and member requests the Worker has authorised (images, restore points), which carry
   * the member's identity in a header only the Worker sets.
   */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (url.hostname === INTERNAL_HOST) return await this.onInternalRequest(request, url);
      const identity = decodeIdentity(request.headers.get(IDENTITY_HEADER));
      if (!identity) throw new HttpError(403, "FORBIDDEN");
      return await this.onMemberRequest(request, url.pathname, identity);
    } catch (error) {
      return errorResponse(error);
    }
  }

  /** `/api/docs/:id/images…` and `/api/docs/:id/restore-points…` for this document. */
  private async onMemberRequest(request: Request, pathname: string, identity: DocumentIdentity): Promise<Response> {
    const match = /^\/api\/docs\/([^/]+)\/(images|restore-points)(?:\/(.*))?$/.exec(pathname);
    if (!match || match[1] !== this.name) throw new HttpError(404, "NOT_FOUND");
    const [, docId, resource, rest = ""] = match;
    const { sql } = this.ctx.storage;
    const route = `${request.method} ${resource}${rest ? "/:id" : ""}`;
    // restore-points/<id>/restore is the one nested route.
    switch (route) {
      case "POST images":
        return uploadImage(sql, docId, identity.memberId, request);
      case "GET images/:id":
        return serveImage(sql, rest);
      case "GET restore-points":
        return json({ points: listPoints(sql) } satisfies ListRestorePointsResponse);
      case "POST restore-points": {
        const { label } = await readJson<CreateRestorePointRequest>(request);
        const name = typeof label === "string" ? label.trim().replace(/\s+/g, " ") : "";
        if (!name || name.length > LIMITS.restorePointLabelLength) {
          throw new HttpError(400, "INVALID", `A name of 1 to ${LIMITS.restorePointLabelLength} characters is required`);
        }
        const point = this.savePoint({ kind: "named", label: name, state: Y.encodeStateAsUpdate(this.document), createdBy: person(identity) });
        return json(point, { status: 201 });
      }
      case "POST restore-points/:id": {
        const pointId = /^([^/]+)\/restore$/.exec(rest)?.[1];
        if (pointId) return json(await this.restore(pointId, identity));
        break;
      }
    }
    throw new HttpError(404, "NOT_FOUND");
  }

  /**
   * Restores a point (plan §2.3): keeps the current document as a `pre-restore` point, rewinds
   * the live document (every connected client receives it as an ordinary change) and saves.
   */
  private async restore(pointId: string, identity: DocumentIdentity): Promise<RestoreResponse> {
    const { sql } = this.ctx.storage;
    const point = isUlid(pointId) ? getPoint(sql, pointId) : null;
    const snapshot = point ? readPointState(sql, pointId) : null;
    if (!point || !snapshot) throw new HttpError(404, "NOT_FOUND");

    const saved = this.savePoint({
      kind: "pre-restore",
      label: point.label ? `Before restoring “${point.label}”` : null,
      state: Y.encodeStateAsUpdate(this.document),
      createdBy: person(identity),
    });
    replaceState(this.document, snapshot);
    this.lastEditor = identity.memberId;
    await this.onSave();
    this.broadcastControl({ type: "restored", by: identity.displayName, at: point.createdAt });
    return { restored: point, saved };
  }

  private async onInternalRequest(request: Request, url: URL): Promise<Response> {
    if (request.method !== "POST") throw new HttpError(404, "NOT_FOUND");
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

const person = (identity: DocumentIdentity) => ({ id: identity.memberId, displayName: identity.displayName });
