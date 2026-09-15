import type { ApiError } from "../shared/protocol";

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

/** JSON request to Colo's own API. Throws ApiRequestError for non-2xx responses. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? undefined : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!response.ok) {
    const error = (data ?? {}) as Partial<ApiError>;
    throw new ApiRequestError(response.status, error.error ?? "HTTP_ERROR", error.message);
  }
  return data as T;
}
