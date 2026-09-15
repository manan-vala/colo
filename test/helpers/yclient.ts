import { exports } from "cloudflare:workers";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { ControlEvent } from "../../src/shared/protocol";
import { ORIGIN } from "./api";

/** A minimal Yjs WebSocket client speaking y-partyserver's protocol, for workerd tests. */
export interface YClient {
  doc: Y.Doc;
  ws: WebSocket;
  events: ControlEvent[];
  closed: Promise<{ code: number; reason: string }>;
  /** Resolves once the server has sent its sync step 2. */
  synced: Promise<void>;
  sendRaw(data: Uint8Array | string): void;
  close(): void;
}

export async function openSocket(docId: string, init: { cookie?: string; origin?: string | null } = {}) {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (init.cookie) headers.Cookie = init.cookie;
  if (init.origin !== null) headers.Origin = init.origin ?? ORIGIN;
  return exports.default.fetch(`${ORIGIN}/api/docs/${docId}/ws`, { headers });
}

export async function connect(docId: string, cookie: string): Promise<YClient> {
  const response = await openSocket(docId, { cookie });
  const ws = response.webSocket;
  if (response.status !== 101 || !ws) throw new Error(`upgrade failed: ${response.status} ${await response.text()}`);
  // workerd delivers binary frames as Blob unless asked otherwise.
  ws.binaryType = "arraybuffer";
  ws.accept();

  const doc = new Y.Doc();
  const events: ControlEvent[] = [];
  let resolveSynced!: () => void;
  const synced = new Promise<void>((resolve) => (resolveSynced = resolve));
  let resolveClosed!: (value: { code: number; reason: string }) => void;
  const closed = new Promise<{ code: number; reason: string }>((resolve) => (resolveClosed = resolve));

  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      if (event.data.startsWith("__YPS:")) events.push(JSON.parse(event.data.slice(6)) as ControlEvent);
      return;
    }
    const decoder = decoding.createDecoder(new Uint8Array(event.data as ArrayBuffer));
    if (decoding.readVarUint(decoder) !== 0) return; // ignore awareness
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    const type = syncProtocol.readSyncMessage(decoder, encoder, doc, "server");
    if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
    if (type === syncProtocol.messageYjsSyncStep2) resolveSynced();
  });
  ws.addEventListener("close", (event) => resolveClosed({ code: event.code, reason: event.reason }));

  doc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "server") return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, 0);
    syncProtocol.writeUpdate(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  });

  const hello = encoding.createEncoder();
  encoding.writeVarUint(hello, 0);
  syncProtocol.writeSyncStep1(hello, doc);
  ws.send(encoding.toUint8Array(hello));

  return {
    doc,
    ws,
    events,
    closed,
    synced,
    sendRaw: (data) => ws.send(data),
    close: () => ws.close(1000, "done"),
  };
}

/** Polls until `check` passes or the timeout elapses. */
export async function eventually(check: () => void, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export function syncStep1Message(doc = new Y.Doc()): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, 0);
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}
