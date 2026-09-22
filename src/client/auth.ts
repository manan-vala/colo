import type { MeResponse } from "../shared/protocol";
import { ApiRequestError, api } from "./api";

export async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await api<MeResponse>("/api/me");
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) return null;
    throw error;
  }
}

export async function signIn(workspace: string, email: string, password: string): Promise<MeResponse> {
  return api<MeResponse>("/api/auth/login", { body: { workspace, email, password } });
}

export async function changePassword(current: string, next: string): Promise<void> {
  await api("/api/auth/password", { body: { current, next } });
}

export async function signOut(): Promise<void> {
  await api("/api/auth/logout", { body: {} });
}

/** Human-readable message for sign-in and password failures. */
export function describeAuthError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "LOGIN_FAILED":
        return "Wrong workspace ID, email or password. After five wrong tries the account waits 15 minutes.";
      case "WRONG_PASSWORD":
        return "Your current password is wrong.";
      default:
        return error.message || "Something went wrong. Please try again.";
    }
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

const LAST_WORKSPACE = "colo:last-workspace";

/** The workspace ID typed last time, so a returning member only types a password. */
export function lastWorkspace(): string {
  try {
    return localStorage.getItem(LAST_WORKSPACE) ?? "";
  } catch {
    return "";
  }
}

export function rememberWorkspace(slug: string): void {
  try {
    localStorage.setItem(LAST_WORKSPACE, slug);
  } catch {
    // Private windows and blocked storage: the field just starts empty next time.
  }
}
