import type {
  AnalysisOut,
  ApiErrorBody,
  ApplyOut,
  DatasetDetailOut,
  DatasetOut,
  FDOut,
  ProposalOut,
  SampleName,
  SchemaOut,
  UserOut,
  WorkspaceOut,
} from "./types"

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly detail: unknown

  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.detail = detail
  }
}

export type ApiInit = RequestInit & { json?: unknown }

const MOCK = import.meta.env.VITE_MOCK === "1"

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const { json, headers, ...rest } = init
  const h = new Headers(headers)
  h.set("Accept", "application/json")
  let body = rest.body
  if (json !== undefined) {
    h.set("Content-Type", "application/json")
    body = JSON.stringify(json)
  }

  // Dev-only fake backend (npm run dev:mock). MOCK is a build-time constant, so
  // a normal build drops this branch and never ships the mock module.
  if (MOCK) {
    const { mockFetch } = await import("./mock")
    const res = await mockFetch(path, { method: rest.method ?? "GET", json })
    return handle<T>(res.status, res.body)
  }

  let res: Response
  try {
    res = await fetch(path, { ...rest, body, headers: h, credentials: "include" })
  } catch {
    throw new ApiError(0, "network_error", "Can't reach the QLens server. Check that the backend is running on port 8000.")
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let parsed: unknown = undefined
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }
  return handle<T>(res.status, parsed)
}

function handle<T>(status: number, body: unknown): T {
  if (status >= 200 && status < 300) return body as T
  const err = (body as ApiErrorBody | undefined)?.error
  if (err) throw new ApiError(status, err.code, err.message, err.detail)
  // FastAPI's own request-validation 422s look like {detail: [...]}
  throw new ApiError(
    status,
    status === 422 ? "validation_error" : "http_error",
    status === 422 ? "Some fields are invalid." : `Request failed (${status}).`,
    body,
  )
}

// ---- auth -------------------------------------------------------------------

export const authApi = {
  me: () => api<UserOut>("/api/auth/me"),
  login: (email: string, password: string) =>
    api<UserOut>("/api/auth/login", { method: "POST", json: { email, password } }),
  signup: (email: string, password: string, display_name: string) =>
    api<UserOut>("/api/auth/signup", { method: "POST", json: { email, password, display_name } }),
  logout: () => api<void>("/api/auth/logout", { method: "POST" }),
}

// ---- workspaces -------------------------------------------------------------

export const workspacesApi = {
  list: () => api<WorkspaceOut[]>("/api/workspaces"),
  get: (id: number) => api<WorkspaceOut>(`/api/workspaces/${id}`),
  create: (name: string) => api<WorkspaceOut>("/api/workspaces", { method: "POST", json: { name } }),
  remove: (id: number) => api<void>(`/api/workspaces/${id}`, { method: "DELETE" }),
}

// ---- dataset ----------------------------------------------------------------

const ws = (id: number) => `/api/workspaces/${id}`

export const datasetApi = {
  get: (wsId: number) => api<DatasetDetailOut>(`${ws(wsId)}/dataset`),
  upload: (wsId: number, file: File) => {
    // No Content-Type header: the browser adds the multipart boundary itself.
    const body = new FormData()
    body.append("file", file)
    return api<DatasetOut>(`${ws(wsId)}/dataset`, { method: "POST", body })
  },
  sample: (wsId: number, name: SampleName) =>
    api<DatasetOut>(`${ws(wsId)}/dataset/sample`, { method: "POST", json: { name } }),
}

// ---- analysis ---------------------------------------------------------------

export const analysisApi = {
  get: (wsId: number) => api<AnalysisOut>(`${ws(wsId)}/analysis`),
  run: (wsId: number) => api<AnalysisOut>(`${ws(wsId)}/analyze`, { method: "POST" }),
  setAccepted: (wsId: number, fdId: number, accepted: boolean) =>
    api<FDOut>(`${ws(wsId)}/fds/${fdId}`, { method: "PATCH", json: { accepted } }),
  merge: (wsId: number, groupId: number, canonical?: string) =>
    api<AnalysisOut>(`${ws(wsId)}/duplicates/${groupId}/merge`, {
      method: "POST",
      json: canonical === undefined ? {} : { canonical },
    }),
  dismiss: (wsId: number, groupId: number) =>
    api<AnalysisOut>(`${ws(wsId)}/duplicates/${groupId}/dismiss`, { method: "POST" }),
  /** overrides: conflictKey(lhs_values) -> value to use instead of the suggestion */
  fix: (wsId: number, fdId: number, overrides?: Record<string, string>) =>
    api<AnalysisOut>(`${ws(wsId)}/inconsistencies/${fdId}/fix`, {
      method: "POST",
      json: overrides && Object.keys(overrides).length ? { overrides } : {},
    }),
  acceptAll: (wsId: number) => api<AnalysisOut>(`${ws(wsId)}/cleanup/accept-all`, { method: "POST" }),
}

// ---- design -----------------------------------------------------------------

export const designApi = {
  /** the draft being edited if there is one, else the applied design (404 no_proposal when neither) */
  get: (wsId: number) => api<ProposalOut>(`${ws(wsId)}/proposal`),
  /** build a fresh draft from the accepted dependencies */
  build: (wsId: number) => api<ProposalOut>(`${ws(wsId)}/proposal`, { method: "POST" }),
  /** a new draft copied from the applied design, keeping its names (409 draft_exists when there is one) */
  editApplied: (wsId: number) => api<ProposalOut>(`${ws(wsId)}/proposal/edit-applied`, { method: "POST" }),
  renameTable: (wsId: number, tableId: number, name: string) =>
    api<ProposalOut>(`${ws(wsId)}/proposal/tables/${tableId}`, { method: "PATCH", json: { name } }),
  renameColumn: (wsId: number, columnId: number, name: string) =>
    api<ProposalOut>(`${ws(wsId)}/proposal/columns/${columnId}`, { method: "PATCH", json: { name } }),
  sql: (wsId: number) => api<{ sql: string }>(`${ws(wsId)}/proposal/sql`),
  apply: (wsId: number, proposalId: number) =>
    api<ApplyOut>(`${ws(wsId)}/apply`, { method: "POST", json: { proposal_id: proposalId } }),
  schema: (wsId: number, kind: "main" | "lab" = "main") => api<SchemaOut>(`${ws(wsId)}/schema?kind=${kind}`),
}
