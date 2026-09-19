import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  SESSION_COOKIE,
  type CreateInviteRequest,
  type CreateInviteResponse,
  type LoginVerifyRequest,
  type Member,
  type RegisterOptionsRequest,
  type RegisterVerifyRequest,
} from "../shared/protocol";
import { DAY, HttpError, MINUTE, base64url, isoIn, isoNow, parseCookies, randomToken, sha256Hex, ulid } from "./http";

/** Invites, passkeys and sessions for the Workspace Durable Object (plan §5). */

const INVITE_TTL = DAY;
const CHALLENGE_TTL = 5 * MINUTE;
const SESSION_TTL = 30 * DAY;
const SESSION_SLIDE_AFTER = DAY;
const RP_NAME = "Colo";
/** ES256 and RS256 (Windows Hello). */
const ALGORITHMS = [-7, -257];

export interface AuthEnv {
  RP_ID: string;
  ORIGIN: string;
  ADMIN_TOKEN?: string;
}

export interface Session {
  member: Member;
  idHash: string;
  expiresAt: string;
  /** Set when the session was extended and the cookie should be re-issued. */
  setCookie?: string;
}

type MemberRow = {
  id: string;
  email: string;
  display_name: string;
  disabled_at: string | null;
};

const toMember = (row: MemberRow): Member => ({ id: row.id, email: row.email, displayName: row.display_name });

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

function requireString(value: unknown, field: string, max = 320): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) {
    throw new HttpError(400, "INVALID", `${field} is required`);
  }
  return value.trim();
}

export class Auth {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly env: AuthEnv,
  ) {}

  private get sql() {
    return this.storage.sql;
  }

  // ---- invites -------------------------------------------------------------

  async createInvite(body: CreateInviteRequest): Promise<CreateInviteResponse> {
    const email = requireString(body.email, "email").toLowerCase();
    const name = requireString(body.name, "name", 80);
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, "INVALID", "email is invalid");

    const token = randomToken();
    const tokenHash = await sha256Hex(token);
    const now = isoNow();
    const expiresAt = isoIn(INVITE_TTL);
    const memberId = this.storage.transactionSync(() => {
      const existing = this.sql
        .exec<{ id: string }>("SELECT id FROM members WHERE email = ?", email)
        .toArray()[0];
      const id = existing?.id ?? ulid();
      if (!existing) {
        this.sql.exec(
          "INSERT INTO members (id, email, display_name, created_at) VALUES (?, ?, ?, ?)",
          id,
          email,
          name,
          now,
        );
      }
      this.sql.exec(
        "INSERT INTO invites (token_hash, member_id, expires_at) VALUES (?, ?, ?)",
        tokenHash,
        id,
        expiresAt,
      );
      return id;
    });
    return { memberId, url: `${this.env.ORIGIN}/invite#${token}`, expiresAt };
  }

  private inviteMember(tokenHash: string): MemberRow {
    const row = this.sql
      .exec<MemberRow & { expires_at: string; used_at: string | null }>(
        `SELECT m.id, m.email, m.display_name, m.disabled_at, i.expires_at, i.used_at
           FROM invites i JOIN members m ON m.id = i.member_id
          WHERE i.token_hash = ?`,
        tokenHash,
      )
      .toArray()[0];
    if (!row || row.used_at || row.expires_at <= isoNow() || row.disabled_at) {
      throw new HttpError(400, "INVITE_INVALID", "This invite link is invalid, used or expired");
    }
    return row;
  }

  // ---- challenges ------------------------------------------------------------

  private storeChallenge(challenge: string, purpose: "register" | "login", memberId: string | null): string {
    const id = ulid();
    this.sql.exec("DELETE FROM auth_challenges WHERE expires_at <= ?", isoNow());
    this.sql.exec(
      "INSERT INTO auth_challenges (id, challenge, purpose, member_id, expires_at) VALUES (?, ?, ?, ?, ?)",
      id,
      challenge,
      purpose,
      memberId,
      isoIn(CHALLENGE_TTL),
    );
    return id;
  }

  /** Deletes and returns a challenge so it can be used at most once. */
  private consumeChallenge(id: unknown, purpose: "register" | "login"): { challenge: string; memberId: string | null } {
    const row = this.sql
      .exec<{ challenge: string; purpose: string; member_id: string | null; expires_at: string }>(
        "DELETE FROM auth_challenges WHERE id = ? RETURNING challenge, purpose, member_id, expires_at",
        typeof id === "string" ? id : "",
      )
      .toArray()[0];
    if (!row || row.purpose !== purpose || row.expires_at <= isoNow()) {
      throw new HttpError(400, "CHALLENGE_INVALID", "The sign-in attempt expired; try again");
    }
    return { challenge: row.challenge, memberId: row.member_id };
  }

  // ---- registration ----------------------------------------------------------

  async registrationOptions(body: RegisterOptionsRequest) {
    const invite = this.inviteMember(await sha256Hex(requireString(body.inviteToken, "inviteToken", 128)));
    const existing = this.sql
      .exec<{ credential_id: string; transports: string | null }>(
        "SELECT credential_id, transports FROM passkeys WHERE member_id = ?",
        invite.id,
      )
      .toArray();
    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: this.env.RP_ID,
      userName: invite.email,
      userDisplayName: invite.display_name,
      userID: new Uint8Array(new TextEncoder().encode(invite.id)),
      attestationType: "none",
      excludeCredentials: existing.map((p) => ({
        id: p.credential_id,
        transports: p.transports ? (JSON.parse(p.transports) as AuthenticatorTransport[]) : undefined,
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      supportedAlgorithmIDs: ALGORITHMS,
    });
    return { challengeId: this.storeChallenge(options.challenge, "register", invite.id), options };
  }

  async verifyRegistration(body: RegisterVerifyRequest): Promise<{ member: Member; cookie: string }> {
    const tokenHash = await sha256Hex(requireString(body.inviteToken, "inviteToken", 128));
    const challenge = this.consumeChallenge(body.challengeId, "register");
    const invite = this.inviteMember(tokenHash);
    if (challenge.memberId !== invite.id) throw new HttpError(400, "CHALLENGE_INVALID");

    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.env.ORIGIN,
        expectedRPID: this.env.RP_ID,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
    } catch (error) {
      throw new HttpError(400, "VERIFICATION_FAILED", error instanceof Error ? error.message : undefined);
    }
    if (!verification.verified) throw new HttpError(400, "VERIFICATION_FAILED");

    const { credential } = verification.registrationInfo;
    const token = randomToken();
    const now = isoNow();
    const idHash = await sha256Hex(token);
    this.storage.transactionSync(() => {
      // Re-check inside the transaction: another request may have used the invite meanwhile.
      const used = this.sql.exec(
        "UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?",
        now,
        tokenHash,
        now,
      );
      if (used.rowsWritten === 0) throw new HttpError(400, "INVITE_INVALID", "This invite link was already used");
      this.sql.exec(
        "INSERT INTO passkeys (credential_id, member_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        credential.id,
        invite.id,
        credential.publicKey,
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
        now,
      );
      this.insertSession(idHash, invite.id, now);
    });
    return { member: toMember(invite), cookie: sessionCookie(token) };
  }

  // ---- sign-in ---------------------------------------------------------------

  async loginOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.env.RP_ID, userVerification: "required" });
    return { challengeId: this.storeChallenge(options.challenge, "login", null), options };
  }

  async verifyLogin(body: LoginVerifyRequest): Promise<{ member: Member; cookie: string }> {
    const challenge = this.consumeChallenge(body.challengeId, "login");
    const response = body.response as AuthenticationResponseJSON;
    const passkey = this.sql
      .exec<MemberRow & { credential_id: string; public_key: ArrayBuffer; counter: number; transports: string | null }>(
        `SELECT p.credential_id, p.public_key, p.counter, p.transports, m.id, m.email, m.display_name, m.disabled_at
           FROM passkeys p JOIN members m ON m.id = p.member_id
          WHERE p.credential_id = ?`,
        typeof response?.id === "string" ? response.id : "",
      )
      .toArray()[0];
    if (!passkey || passkey.disabled_at) throw new HttpError(401, "UNKNOWN_PASSKEY", "This passkey is not registered");

    // Registration used the member ID as the WebAuthn user handle.
    const userHandle = response.response?.userHandle;
    if (userHandle && userHandle !== base64url(new TextEncoder().encode(passkey.id))) {
      throw new HttpError(401, "VERIFICATION_FAILED", "Passkey does not belong to this member");
    }

    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: this.env.ORIGIN,
        expectedRPID: this.env.RP_ID,
        requireUserVerification: true,
        credential: {
          id: passkey.credential_id,
          publicKey: new Uint8Array(passkey.public_key),
          counter: passkey.counter,
          transports: passkey.transports ? JSON.parse(passkey.transports) : undefined,
        },
      });
    } catch (error) {
      throw new HttpError(401, "VERIFICATION_FAILED", error instanceof Error ? error.message : undefined);
    }
    if (!verification.verified) throw new HttpError(401, "VERIFICATION_FAILED");

    const token = randomToken();
    const now = isoNow();
    const idHash = await sha256Hex(token);
    this.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE passkeys SET counter = ?, last_used_at = ? WHERE credential_id = ?",
        verification.authenticationInfo.newCounter,
        now,
        passkey.credential_id,
      );
      this.insertSession(idHash, passkey.id, now);
    });
    return { member: toMember(passkey), cookie: sessionCookie(token) };
  }

  // ---- sessions --------------------------------------------------------------

  private insertSession(idHash: string, memberId: string, now: string) {
    this.sql.exec("DELETE FROM sessions WHERE expires_at <= ?", now);
    this.sql.exec(
      "INSERT INTO sessions (id_hash, member_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
      idHash,
      memberId,
      now,
      isoIn(SESSION_TTL),
      now,
    );
  }

  /** Resolves the session cookie; slides the expiry at most once a day. Returns null if not signed in. */
  /**
   * The member behind a session cookie. Extends the session at most once a day; callers that
   * cannot return the re-issued cookie to the browser pass `slide: false`, or the server's
   * expiry would move while the browser's cookie does not.
   */
  async authenticate(cookieHeader: string | null, { slide = true }: { slide?: boolean } = {}): Promise<Session | null> {
    const token = parseCookies(cookieHeader).get(SESSION_COOKIE);
    if (!token || token.length > 128) return null;
    const idHash = await sha256Hex(token);
    const now = isoNow();
    const row = this.sql
      .exec<MemberRow & { expires_at: string; last_seen_at: string }>(
        `SELECT m.id, m.email, m.display_name, m.disabled_at, s.expires_at, s.last_seen_at
           FROM sessions s JOIN members m ON m.id = s.member_id
          WHERE s.id_hash = ? AND s.expires_at > ? AND m.disabled_at IS NULL`,
        idHash,
        now,
      )
      .toArray()[0];
    if (!row) return null;

    const session: Session = { member: toMember(row), idHash, expiresAt: row.expires_at };
    if (slide && Date.parse(now) - Date.parse(row.last_seen_at) >= SESSION_SLIDE_AFTER) {
      session.expiresAt = isoIn(SESSION_TTL);
      this.sql.exec(
        "UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id_hash = ?",
        session.expiresAt,
        now,
        idHash,
      );
      session.setCookie = sessionCookie(token);
    }
    return session;
  }

  /** Deletes the session; returns its hash so callers can close its sockets. */
  async logout(cookieHeader: string | null): Promise<string | null> {
    const token = parseCookies(cookieHeader).get(SESSION_COOKIE);
    if (!token) return null;
    const idHash = await sha256Hex(token);
    this.sql.exec("DELETE FROM sessions WHERE id_hash = ?", idHash);
    return idHash;
  }
}
