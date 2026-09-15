import {
  WebAuthnError,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type { CeremonyOptionsResponse, Member, MeResponse } from "../shared/protocol";
import { ApiRequestError, api } from "./api";

export async function fetchMe(): Promise<Member | null> {
  try {
    return (await api<MeResponse>("/api/me")).member;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) return null;
    throw error;
  }
}

export async function registerWithInvite(inviteToken: string): Promise<Member> {
  const { challengeId, options } = await api<CeremonyOptionsResponse<PublicKeyCredentialCreationOptionsJSON>>(
    "/api/auth/register/options",
    { body: { inviteToken } },
  );
  const response = await startRegistration({ optionsJSON: options });
  return (await api<MeResponse>("/api/auth/register/verify", { body: { inviteToken, challengeId, response } }))
    .member;
}

export async function signInWithPasskey(): Promise<Member> {
  const { challengeId, options } = await api<CeremonyOptionsResponse<PublicKeyCredentialRequestOptionsJSON>>(
    "/api/auth/login/options",
    { body: {} },
  );
  const response = await startAuthentication({ optionsJSON: options });
  return (await api<MeResponse>("/api/auth/login/verify", { body: { challengeId, response } })).member;
}

export async function signOut(): Promise<void> {
  await api("/api/auth/logout", { body: {} });
}

/** Human-readable message for passkey and API failures. */
export function describeAuthError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "INVITE_INVALID":
        return "This invite link is invalid, already used or expired. Ask for a new one.";
      case "UNKNOWN_PASSKEY":
        return "This passkey isn't registered with Colo.";
      case "CHALLENGE_INVALID":
        return "That took too long. Please try again.";
      default:
        return error.message || "Something went wrong. Please try again.";
    }
  }
  if (error instanceof WebAuthnError || (error instanceof Error && error.name === "NotAllowedError")) {
    return "The passkey prompt was cancelled or timed out.";
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}
