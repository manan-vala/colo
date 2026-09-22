import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../shared/protocol";
import { HttpError, fromBase64, toBase64 } from "./http";

/**
 * Member passwords (M9, ADR 0006). PBKDF2-SHA256 through WebCrypto, because the Workers runtime
 * has no native bcrypt, scrypt or Argon2 and a WASM one would cost far more CPU per sign-in.
 *
 * 100,000 iterations is the most the runtime allows in one `deriveBits` call — below OWASP's
 * 600,000 for PBKDF2-SHA256, which is why sign-in also locks an account after repeated failures
 * and generated passwords carry about 98 bits. The count is stored with each hash so it
 * can be raised if the runtime ever allows more. Hashing runs in the Workspace object, whose CPU
 * limit is 30 s, not in the Worker with its 10 ms.
 */
export const PASSWORD_ITERATIONS = 100_000;

export interface PasswordHash {
  hash: string;
  salt: string;
  iterations: number;
}

const encoder = new TextEncoder();

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PASSWORD_ITERATIONS);
  return { hash: toBase64(hash), salt: toBase64(salt), iterations: PASSWORD_ITERATIONS };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const hash = await derive(password, fromBase64(stored.salt), stored.iterations);
  const expected = fromBase64(stored.hash);
  return hash.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(hash, expected);
}

/** Spends the same work as a real check, so an unknown email takes as long as a wrong password. */
export async function burnPasswordCheck(password: string): Promise<void> {
  await derive(password, new Uint8Array(16), PASSWORD_ITERATIONS);
}

export function validatePassword(value: unknown, field = "password"): string {
  if (typeof value !== "string" || value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    throw new HttpError(
      400,
      "INVALID_PASSWORD",
      `${field} must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  return value;
}

/** No 0/o, 1/l/i or u: a password read out loud or copied by hand should survive it. */
const ALPHABET = "23456789abcdefghjkmnpqrstvwxyz";

/** 20 characters in five groups of four, about 98 bits: easy to read out or paste. */
export function generatePassword(): string {
  const chars: string[] = [];
  // Rejection sampling keeps every character equally likely (256 is not a multiple of 30).
  const limit = 256 - (256 % ALPHABET.length);
  while (chars.length < 20) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < limit && chars.length < 20) chars.push(ALPHABET[byte % ALPHABET.length]);
    }
  }
  return chars.join("").match(/.{4}/g)!.join("-");
}
