import type {
  V5AgentDetail,
  V5SessionDetail,
  V5Settings,
  V5Workspace,
} from "./contracts";

export class V5ApiError extends Error {
  status: number;
  code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "V5ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v5${path}`, {
      ...init,
      credentials: "include",
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new V5ApiError("V5 service is unreachable. Check the Razer stack and retry.", 0);
  }

  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    let code: string | null = null;
    try {
      const body = (await response.json()) as { detail?: unknown; message?: unknown; code?: unknown };
      const detail = body.detail && typeof body.detail === "object"
        ? body.detail as { message?: unknown; code?: unknown }
        : null;
      if (typeof body.message === "string") message = body.message;
      else if (typeof body.detail === "string") message = body.detail;
      else if (typeof detail?.message === "string") message = detail.message;
      if (typeof body.code === "string") code = body.code;
      else if (typeof detail?.code === "string") code = detail.code;
      if (code && message === `Request failed (${response.status}).`) message = `Request rejected: ${code}`;
    } catch {
      // Keep the status-based message when the server returned no JSON body.
    }
    throw new V5ApiError(message, response.status, code);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const v5Api = {
  auth: () => request<{ authenticated: boolean }>("/auth"),
  login: (token: string) =>
    request<{ authenticated: boolean }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  workspace: () => request<V5Workspace>("/workspace"),
  agent: (id: string) => request<V5AgentDetail>(`/agents/${encodeURIComponent(id)}`),
  inspect: (id: string) =>
    request<V5SessionDetail>(`/agents/${encodeURIComponent(id)}/inspect`, { method: "POST" }),
  report: (id: string) =>
    request<V5SessionDetail>(`/agents/${encodeURIComponent(id)}/report`, { method: "POST" }),
  startLoop: (id: string, loopId: string, frequencySec: number, maxTicks: number) =>
    request<V5SessionDetail>(`/agents/${encodeURIComponent(id)}/loops/start`, {
      method: "POST",
      body: JSON.stringify({ loop_id: loopId, frequency_sec: frequencySec, max_ticks: maxTicks }),
    }),
  sessions: async () => {
    const result = await request<{ sessions: V5SessionDetail[] }>("/sessions");
    if (!Array.isArray(result.sessions)) throw new V5ApiError("The V5 service returned an invalid sessions collection.", 502, "INVALID_SESSION_LIST");
    return result.sessions;
  },
  session: (id: string) => request<V5SessionDetail>(`/sessions/${encodeURIComponent(id)}`),
  stopSession: (id: string) =>
    request<V5SessionDetail>(`/sessions/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  saveNotes: (id: string, text: string) =>
    request<{ notes: string }>(`/agents/${encodeURIComponent(id)}/notes`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    }),
  settings: () => request<V5Settings>("/settings"),
};
