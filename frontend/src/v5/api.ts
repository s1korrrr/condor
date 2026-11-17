import type {
  V5AgentDetail,
  V5SessionDetail,
  V5Settings,
  V5Workspace,
  V5TaskReport,
} from "./contracts";
import { isProjectionReadError, readProjection } from "./learning-projection";

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
  auth: () => request<{ authenticated: boolean; learning_projection_revision?: string }>("/auth"),
  profile: () => request<V5DashboardProfile>("/dashboard/profile"),
  login: (token: string) =>
    request<{ authenticated: boolean }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ token }),
    }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  workspace: () => request<V5Workspace>("/workspace"),
  advisorHistory: async (task: string) => {
    const result = await request<{ effect: "NONE"; records: V5TaskReport[] }>(`/advisor/history?task_id=${encodeURIComponent(task)}&limit=5`);
    if (!result || result.effect !== "NONE" || !Array.isArray(result.records)) throw new V5ApiError("The advisor returned invalid history.", 502, "INVALID_HISTORY");
    return result;
  },
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

/**
 * Legacy reads of the fixture-era learning routes (`roles`, `research`). `manifest` now returns the validated
 * Stage-A projection manifest and throws `V5ApiError` on a typed failure. New code uses `readProjection`,
 * `useProjectionPages` and `useManifest` from `./learning-projection`.
 */
export async function learningRead<T>(path: 'manifest' | 'roles' | `research?cursor=${number}&limit=25`): Promise<T> {
  if (path === 'manifest') {
    try {
      return await readProjection('manifest') as T;
    } catch (error) {
      if (isProjectionReadError(error)) throw new V5ApiError(`Learning projection ${error.error.code}`, error.error.status, error.error.code);
      throw error;
    }
  }
  const data = await request<unknown>(`/learning/${path}`);
  if (!data || typeof data !== 'object' || (data as { effect?: unknown }).effect !== 'NONE') {
    throw new V5ApiError('Invalid non-authorizing projection.', 502, 'INVALID_LEARNING_PROJECTION');
  }
  return data as T;
}

export interface V5DashboardProfile {
  candle_store?: { configured: boolean };
  tradepad_campaign_id?: string;
  schema_version: "v5-dashboard-profile.v1";
  server: { server_id: string; host: string; port: number; mode: string; execution_enabled: boolean };
  condor: { base_revision: string };
  readiness: {
    native_owner: string;
    native_owner_reason?: string;
    account_owner: string;
    research_owner: string;
    tradepad_owner: string;
    market_picture_owner: string;
    /** Present only when the deployment configures a read-only paper status file. */
    paper_owner?: {
      bot_name: string | null;
      state: "FRESH" | "STALE" | "UNAVAILABLE";
      reason: string;
      mode: "PAPER";
      execution: "SIMULATED_WALLET_ONLY";
      generated_at: number | null;
      ready: boolean | null;
      readiness_reasons: string[];
      failure: string | null;
    };
  };
}
