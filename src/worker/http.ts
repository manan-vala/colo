/** Small helpers shared by the Worker and the Durable Objects. */

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export function json(body: unknown, init: ResponseInit = {}): Response {
  return Response.json(body, init);
}

export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json({ error: error.code, message: error.message }, { status: error.status });
  }
  console.error("unhandled error", error);
  return json({ error: "INTERNAL" }, { status: 500 });
}

const MAX_JSON_BYTES = 64 * 1024;

export async function readJson<T>(request: Request): Promise<T> {
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw new HttpError(413, "TOO_LARGE");
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

const encoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison of two strings of any length (compares their SHA-256 digests). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(da, db);
}

export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function randomToken(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Standard base64, for the binary payloads in a backup (§8.5). Chunked: the argument list of
 *  String.fromCharCode is bounded, and a state chunk is 1.9 MB. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let lastTime = -1;
let lastRandom: number[] = [];

/**
 * Monotonic ULID: 48-bit millisecond timestamp + 80 random bits, Crockford base32. Within one
 * millisecond the random part is the previous one plus one, so IDs made by this isolate always
 * sort in creation order (restore points rely on it for "newest first").
 */
export function ulid(now = Date.now()): string {
  let time = "";
  for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  // In the same millisecond, `increment` advances lastRandom in place.
  if (now !== lastTime || !increment(lastRandom)) {
    lastTime = now;
    lastRandom = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte % 32);
  }
  return time + lastRandom.map((digit) => CROCKFORD[digit]).join("");
}

/** Adds one to base-32 digits in place; false if they overflow (then fresh randomness is used). */
function increment(digits: number[]): boolean {
  for (let i = digits.length - 1; i >= 0; i--) {
    if (digits[i] < 31) {
      digits[i]++;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}

export function isoNow(): string {
  return new Date().toISOString();
}

export function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
