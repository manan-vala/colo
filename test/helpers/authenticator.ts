import { encodeCBOR, type CBORType } from "@levischuck/tiny-cbor";

/**
 * A minimal software passkey (ES256, attestation "none") for tests. It produces the same
 * JSON that @simplewebauthn/browser returns, so server code can be exercised end to end.
 */

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

const encoder = new TextEncoder();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data));
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** WebCrypto returns raw r||s; WebAuthn assertions carry a DER-encoded ECDSA signature. */
function rawToDer(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let i = 0;
    while (i < bytes.length - 1 && bytes[i] === 0) i++;
    let value: Uint8Array = bytes.slice(i);
    if (value[0] & 0x80) value = concat(new Uint8Array([0]), value);
    return concat(new Uint8Array([0x02, value.length]), value);
  };
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_AT = 0x40;

export interface SoftAuthenticator {
  credentialId: string;
  userHandle?: string;
  register(options: { challenge: string; rp: { id?: string }; user: { id: string } }, origin: string): Promise<unknown>;
  authenticate(options: { challenge: string; rpId?: string }, origin: string): Promise<unknown>;
}

export async function createSoftAuthenticator(opts: { userVerified?: boolean } = {}): Promise<SoftAuthenticator> {
  const keys = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  const rawId = crypto.getRandomValues(new Uint8Array(16));
  const flags = FLAG_UP | (opts.userVerified === false ? 0 : FLAG_UV);
  let counter = 0;

  const authenticator: SoftAuthenticator = {
    credentialId: b64url(rawId),

    async register(options, origin) {
      const rpId = options.rp.id ?? new URL(origin).hostname;
      authenticator.userHandle = options.user.id;
      const clientDataJSON = encoder.encode(
        JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin, crossOrigin: false }),
      );
      const coseKey = new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromB64url(jwk.x!)],
        [-3, fromB64url(jwk.y!)],
      ]);
      const authData = concat(
        await sha256(encoder.encode(rpId)),
        new Uint8Array([flags | FLAG_AT]),
        uint32(counter),
        new Uint8Array(16),
        new Uint8Array([0, rawId.length]),
        rawId,
        encodeCBOR(coseKey as Map<string | number, CBORType>),
      );
      const attestationObject = encodeCBOR(
        new Map<string, CBORType>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id: b64url(rawId),
        rawId: b64url(rawId),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          attestationObject: b64url(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },

    async authenticate(options, origin) {
      const rpId = options.rpId ?? new URL(origin).hostname;
      counter += 1;
      const clientDataJSON = encoder.encode(
        JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin, crossOrigin: false }),
      );
      const authData = concat(await sha256(encoder.encode(rpId)), new Uint8Array([flags]), uint32(counter));
      const signed = concat(authData, await sha256(clientDataJSON));
      const raw = new Uint8Array(
        await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, signed),
      );
      return {
        id: b64url(rawId),
        rawId: b64url(rawId),
        type: "public-key",
        response: {
          clientDataJSON: b64url(clientDataJSON),
          authenticatorData: b64url(authData),
          signature: b64url(rawToDer(raw)),
          userHandle: authenticator.userHandle,
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
  return authenticator;
}
