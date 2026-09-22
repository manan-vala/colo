import {
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import type {
  AdminMembersResponse,
  AdminWorkspace,
  AdminWorkspacesResponse,
  CeremonyOptionsResponse,
  CreateWorkspaceRequest,
  AddMemberRequest,
  MemberChangeResponse,
  UpdateMemberRequest,
  UpdateWorkspaceRequest,
} from "../../shared/protocol";
import { ApiRequestError, api } from "../api";

/** The owner's dashboard API (M9); every route but sign-in needs the owner's session cookie. */

export async function isOwnerSignedIn(): Promise<boolean> {
  try {
    await api("/api/admin/me");
    return true;
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 401) return false;
    throw error;
  }
}

export async function enrollOwnerPasskey(token: string): Promise<void> {
  const { challengeId, options } = await api<CeremonyOptionsResponse<PublicKeyCredentialCreationOptionsJSON>>(
    "/api/admin/enroll/options",
    { body: { token } },
  );
  const response = await startRegistration({ optionsJSON: options });
  await api("/api/admin/enroll/verify", { body: { token, challengeId, response } });
}

export async function signInOwner(): Promise<void> {
  const { challengeId, options } = await api<CeremonyOptionsResponse<PublicKeyCredentialRequestOptionsJSON>>(
    "/api/admin/login/options",
    { body: {} },
  );
  const response = await startAuthentication({ optionsJSON: options });
  await api("/api/admin/login/verify", { body: { challengeId, response } });
}

export async function signOutOwner(): Promise<void> {
  await api("/api/admin/logout", { body: {} });
}

export async function listWorkspaces(): Promise<AdminWorkspace[]> {
  return (await api<AdminWorkspacesResponse>("/api/admin/workspaces")).workspaces;
}

export function createWorkspace(body: CreateWorkspaceRequest): Promise<AdminWorkspace> {
  return api<AdminWorkspace>("/api/admin/workspaces", { body });
}

export function updateWorkspace(slug: string, body: UpdateWorkspaceRequest): Promise<AdminWorkspace> {
  return api<AdminWorkspace>(`/api/admin/workspaces/${encodeURIComponent(slug)}`, { method: "PATCH", body });
}

export async function listMembers(slug: string) {
  return (await api<AdminMembersResponse>(`/api/admin/workspaces/${encodeURIComponent(slug)}/members`)).members;
}

export function addMember(slug: string, body: AddMemberRequest): Promise<MemberChangeResponse> {
  return api<MemberChangeResponse>(`/api/admin/workspaces/${encodeURIComponent(slug)}/members`, { body });
}

export function updateMember(slug: string, id: string, body: UpdateMemberRequest): Promise<MemberChangeResponse> {
  return api<MemberChangeResponse>(`/api/admin/workspaces/${encodeURIComponent(slug)}/members/${id}`, {
    method: "PATCH",
    body,
  });
}

export function describeOwnerError(error: unknown): string {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case "ENROLL_INVALID":
        return "This enrollment link is invalid, already used or expired. Run npm run admin:enroll for a new one.";
      case "UNKNOWN_PASSKEY":
        return "That passkey isn't the owner's.";
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
