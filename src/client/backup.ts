import type { MeResponse } from "../shared/protocol";
import { api } from "./api";

/**
 * Downloads a full backup of the workspace (plan §8.5, F14).
 *
 * The response is a stream that can run to hundreds of megabytes, so it is never read into the
 * page: a link to `/api/export` lets the browser write it straight to disk under the name the
 * `Content-Disposition` header gives it.
 *
 * `/api/me` runs first because that navigation shows whatever comes back. Without it an expired
 * session would be saved as a file containing an error, instead of taking the usual signed-out
 * path; `api` throws `ApiRequestError` with status 401, which the caller already handles.
 */
export async function downloadBackup(): Promise<void> {
  await api<MeResponse>("/api/me");
  const link = document.createElement("a");
  link.href = "/api/export";
  // Empty, so the server's own filename is used.
  link.download = "";
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}
