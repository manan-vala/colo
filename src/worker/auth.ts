import {
  SESSION_COOKIE,
  type ChangePasswordRequest,
  type LoginRequest,
  type Member,
} from "../shared/protocol";
import { DAY, HttpError, MINUTE, isoIn, isoNow, parseCookies, randomToken, sha256Hex } from "./http";
import { burnPasswordCheck, hashPassword, validatePassword, verifyPassword } from "./passwords";

/** Passwords and sessions for one Workspace Durable Object (plan §5, M9). */

const SESSION_TTL = 30 * DAY;
const SESSION_SLIDE_AFTER = DAY;
/** Failed sign-ins in a row before an account is locked, and for how long. */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT = 15 * MINUTE;

/** Workspace object names: the pre-M9 workspace, or `ws-` and a ULID. */
export const WORKSPACE_OBJECT_NAME = /^(?:default|ws-[0-9A-HJKMNP-TV-Z]{26})$/;

export interface Session {
  member: Member;
  idHash: string;
  expiresAt: string;
  /** Set when the session was extended and the cookie should be re-issued. */
  setCookie?: string;
}

export type MemberRow = {
  id: string;
  email: string;
  display_name: string;
  disabled_at: string | null;
};

export const toMember = (row: MemberRow): Member => ({ id: row.id, email: row.email, displayName: row.display_name });

/**
 * The cookie carries the workspace object's name before the token, so the Worker can send each
 * request to the right workspace without asking the Admin object (plan §2.1).
 */
export function sessionCookie(workspace: string, token: string): string {
  return `${SESSION_COOKIE}=${workspace}.${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}`;
}

export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

/** The workspace object name and token in a session cookie, or null if it is not one of ours. */
export function readSessionCookie(cookieHeader: string | null): { workspace: string; token: string } | null {
  const value = parseCookies(cookieHeader).get(SESSION_COOKIE);
  if (!value || value.length > 200) return null;
  const dot = value.indexOf(".");
  const workspace = value.slice(0, dot);
  const token = value.slice(dot + 1);
  if (dot < 0 || !WORKSPACE_OBJECT_NAME.test(workspace) || !token) return null;
  return { workspace, token };
}

type PasswordRow = MemberRow & {
  password_hash: string | null;
  password_salt: string | null;
  password_iterations: number | null;
  failed_logins: number;
  locked_until: string | null;
};

export class Auth {
  constructor(
    private readonly storage: DurableObjectStorage,
    /** This workspace object's name, written into its session cookies. */
    private readonly workspace: string,
  ) {}

  private get sql() {
    return this.storage.sql;
  }

  private workspaceDisabled(): boolean {
    return (
      this.sql.exec<{ disabled_at: string | null }>("SELECT disabled_at FROM workspace_info WHERE id = 1").toArray()[0]
        ?.disabled_at != null
    );
  }

  // ---- passwords -------------------------------------------------------------

  /**
   * Every failure — unknown email, wrong password, locked or disabled account, disabled
   * workspace — is the same `LOGIN_FAILED`, so sign-in never tells a stranger which addresses
   * are members. An unknown email still spends a full hash for the same reason.
   */
  async login(body: LoginRequest): Promise<{ member: Member; cookie: string }> {
    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password.slice(0, 1024) : "";
    const failed = () => new HttpError(401, "LOGIN_FAILED", "Wrong workspace, email or password");

    const row = this.sql
      .exec<PasswordRow>(
        `SELECT id, email, display_name, disabled_at, password_hash, password_salt, password_iterations,
                failed_logins, locked_until
           FROM members WHERE email = ?`,
        email,
      )
      .toArray()[0];
    if (!row || !row.password_hash || !row.password_salt || !row.password_iterations) {
      await burnPasswordCheck(password);
      throw failed();
    }
    const now = isoNow();
    const locked = row.locked_until !== null && row.locked_until > now;
    const ok =
      !locked &&
      (await verifyPassword(password, {
        hash: row.password_hash,
        salt: row.password_salt,
        iterations: row.password_iterations,
      }));
    if (!ok) {
      if (!locked) {
        const failures = row.failed_logins + 1;
        this.sql.exec(
          "UPDATE members SET failed_logins = ?, locked_until = ? WHERE id = ?",
          failures >= MAX_FAILED_LOGINS ? 0 : failures,
          failures >= MAX_FAILED_LOGINS ? isoIn(LOCKOUT) : null,
          row.id,
        );
      }
      throw failed();
    }
    if (row.disabled_at || this.workspaceDisabled()) throw failed();

    const token = randomToken();
    const idHash = await sha256Hex(token);
    this.storage.transactionSync(() => {
      this.sql.exec(
        "UPDATE members SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?",
        now,
        row.id,
      );
      this.insertSession(idHash, row.id, now);
    });
    return { member: toMember(row), cookie: sessionCookie(this.workspace, token) };
  }

  /** Sets a member's password; the caller decides which of their sessions end. */
  async setPassword(memberId: string, password: string): Promise<void> {
    const hashed = await hashPassword(validatePassword(password));
    this.sql.exec(
      `UPDATE members SET password_hash = ?, password_salt = ?, password_iterations = ?, password_changed_at = ?,
              failed_logins = 0, locked_until = NULL
        WHERE id = ?`,
      hashed.hash,
      hashed.salt,
      hashed.iterations,
      isoNow(),
      memberId,
    );
  }

  /** A member changing their own password; ends their other sessions and returns their hashes. */
  async changePassword(session: Session, body: ChangePasswordRequest): Promise<string[]> {
    const next = validatePassword(body.next, "The new password");
    const row = this.sql
      .exec<PasswordRow>(
        "SELECT password_hash, password_salt, password_iterations FROM members WHERE id = ?",
        session.member.id,
      )
      .toArray()[0];
    const current = typeof body.current === "string" ? body.current.slice(0, 1024) : "";
    const ok =
      row?.password_hash &&
      row.password_salt &&
      row.password_iterations &&
      (await verifyPassword(current, {
        hash: row.password_hash,
        salt: row.password_salt,
        iterations: row.password_iterations,
      }));
    if (!ok) throw new HttpError(400, "WRONG_PASSWORD", "The current password is wrong");
    await this.setPassword(session.member.id, next);
    return this.endSessions(session.member.id, session.idHash);
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

  /** Deletes a member's sessions, all or all but one, and returns their hashes to close sockets. */
  endSessions(memberId: string, keep: string | null = null): string[] {
    return this.sql
      .exec<{ id_hash: string }>(
        "DELETE FROM sessions WHERE member_id = ? AND id_hash IS NOT ? RETURNING id_hash",
        memberId,
        keep,
      )
      .toArray()
      .map((row) => row.id_hash);
  }

  /** Deletes every session in the workspace (it was disabled) and returns their hashes. */
  endAllSessions(): string[] {
    return this.sql
      .exec<{ id_hash: string }>("DELETE FROM sessions RETURNING id_hash")
      .toArray()
      .map((row) => row.id_hash);
  }

  /**
   * The member behind a session cookie. Extends the session at most once a day; callers that
   * cannot return the re-issued cookie to the browser pass `slide: false`, or the server's
   * expiry would move while the browser's cookie does not.
   */
  async authenticate(cookieHeader: string | null, { slide = true }: { slide?: boolean } = {}): Promise<Session | null> {
    const cookie = readSessionCookie(cookieHeader);
    if (!cookie || cookie.workspace !== this.workspace || cookie.token.length > 128) return null;
    const idHash = await sha256Hex(cookie.token);
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
    if (!row || this.workspaceDisabled()) return null;

    const session: Session = { member: toMember(row), idHash, expiresAt: row.expires_at };
    if (slide && Date.parse(now) - Date.parse(row.last_seen_at) >= SESSION_SLIDE_AFTER) {
      session.expiresAt = isoIn(SESSION_TTL);
      this.sql.exec(
        "UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id_hash = ?",
        session.expiresAt,
        now,
        idHash,
      );
      session.setCookie = sessionCookie(this.workspace, cookie.token);
    }
    return session;
  }

  /** Deletes the session; returns its hash so callers can close its sockets. */
  async logout(cookieHeader: string | null): Promise<string | null> {
    const cookie = readSessionCookie(cookieHeader);
    if (!cookie || cookie.workspace !== this.workspace) return null;
    const idHash = await sha256Hex(cookie.token);
    this.sql.exec("DELETE FROM sessions WHERE id_hash = ?", idHash);
    return idHash;
  }
}
