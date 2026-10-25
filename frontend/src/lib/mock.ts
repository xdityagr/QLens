// Fake backend for `npm run dev:mock`, so the UI can be built before the real
// API exists. Only auth and workspaces are faked; anything else answers 501.
// State lives in sessionStorage so a page reload keeps you signed in.
import type { UserOut, WorkspaceOut } from "./types"

interface MockUser extends UserOut {
  password: string
}

type MockWorkspace = WorkspaceOut & { owner_id: number }

interface MockState {
  users: MockUser[]
  sessionUserId: number | null
  workspaces: MockWorkspace[]
  nextId: number
}

export const MOCK_DEMO = { email: "riya@example.com", password: "qlens-demo" }

const KEY = "qlens.mock.v1"

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString()
}

function seed(): MockState {
  const owner_id = 1
  const ws = (w: Omit<MockWorkspace, "owner_id">): MockWorkspace => ({ ...w, owner_id })
  return {
    users: [{ id: 1, email: MOCK_DEMO.email, display_name: "Riya Sharma", password: MOCK_DEMO.password }],
    sessionUserId: null,
    nextId: 5,
    workspaces: [
      ws({ id: 1, name: "Coaching fees", created_at: ago(60 * 24 * 3), stage: "applied", row_count: 3000, column_count: 14, table_count: 4, query_count: 12, last_activity_at: ago(18) }),
      ws({ id: 2, name: "Kirana orders", created_at: ago(60 * 24 * 2), stage: "analyzed", row_count: 8412, column_count: 11, table_count: null, query_count: 0, last_activity_at: ago(60 * 5) }),
      ws({ id: 3, name: "Hostel allotment", created_at: ago(60 * 26), stage: "imported", row_count: 1260, column_count: 9, table_count: null, query_count: 0, last_activity_at: ago(60 * 25) }),
      ws({ id: 4, name: "Library loans", created_at: ago(60 * 24 * 9), stage: "empty", row_count: null, column_count: null, table_count: null, query_count: 0, last_activity_at: ago(60 * 24 * 9) }),
    ],
  }
}

function load(): MockState {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw) return JSON.parse(raw) as MockState
  } catch {
    // storage blocked: fall through to a fresh seed
  }
  return seed()
}

let state = load()

function save() {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state))
  } catch {
    // in-memory only
  }
}

type Res = { status: number; body?: unknown }

const fail = (status: number, code: string, message: string): Res => ({
  status,
  body: { error: { code, message } },
})
const publicUser = (u: MockUser): UserOut => ({ id: u.id, email: u.email, display_name: u.display_name })
function publicWs(w: MockWorkspace): WorkspaceOut {
  const { owner_id, ...rest } = w
  void owner_id
  return rest
}

export async function mockFetch(path: string, req: { method: string; json?: unknown }): Promise<Res> {
  await new Promise((r) => setTimeout(r, 220 + Math.random() * 180))
  const res = route(path.split("?")[0], req.method.toUpperCase(), (req.json ?? {}) as Record<string, unknown>)
  save()
  return res
}

function route(path: string, method: string, body: Record<string, unknown>): Res {
  const me = state.users.find((u) => u.id === state.sessionUserId) ?? null

  if (path === "/api/auth/login" && method === "POST") {
    const email = String(body.email ?? "").trim().toLowerCase()
    const user = state.users.find((u) => u.email === email && u.password === body.password)
    if (!user) return fail(401, "invalid_credentials", "Email or password is incorrect.")
    state.sessionUserId = user.id
    return { status: 200, body: publicUser(user) }
  }
  if (path === "/api/auth/signup" && method === "POST") {
    const email = String(body.email ?? "").trim().toLowerCase()
    const password = String(body.password ?? "")
    if (password.length < 8) return fail(422, "validation_error", "Password must be at least 8 characters.")
    if (state.users.some((u) => u.email === email))
      return fail(409, "email_taken", "An account with this email already exists.")
    const user: MockUser = {
      id: state.users.length + 1,
      email,
      display_name: String(body.display_name ?? ""),
      password,
    }
    state.users.push(user)
    state.sessionUserId = user.id
    return { status: 201, body: publicUser(user) }
  }
  if (path === "/api/auth/logout" && method === "POST") {
    state.sessionUserId = null
    return { status: 204 }
  }

  if (!me) return fail(401, "not_authenticated", "Sign in to continue.")

  if (path === "/api/auth/me" && method === "GET") return { status: 200, body: publicUser(me) }

  const mine = state.workspaces.filter((w) => w.owner_id === me.id)
  if (path === "/api/workspaces" && method === "GET") {
    const sorted = [...mine].sort((a, b) => (b.last_activity_at ?? "").localeCompare(a.last_activity_at ?? ""))
    return { status: 200, body: sorted.map(publicWs) }
  }
  if (path === "/api/workspaces" && method === "POST") {
    const name = String(body.name ?? "").trim()
    if (!name) return fail(422, "validation_error", "Give the workspace a name.")
    if (mine.some((w) => w.name.toLowerCase() === name.toLowerCase()))
      return fail(409, "workspace_name_taken", "You already have a workspace with this name.")
    const now = new Date().toISOString()
    const ws: MockWorkspace = {
      id: state.nextId++,
      owner_id: me.id,
      name,
      created_at: now,
      stage: "empty",
      row_count: null,
      column_count: null,
      table_count: null,
      query_count: 0,
      last_activity_at: now,
    }
    state.workspaces.push(ws)
    return { status: 201, body: publicWs(ws) }
  }
  const m = path.match(/^\/api\/workspaces\/(\d+)$/)
  if (m) {
    const ws = mine.find((w) => w.id === Number(m[1]))
    if (!ws) return fail(404, "workspace_not_found", "This workspace doesn't exist or isn't yours.")
    if (method === "GET") return { status: 200, body: publicWs(ws) }
    if (method === "DELETE") {
      state.workspaces = state.workspaces.filter((w) => w !== ws)
      return { status: 204 }
    }
  }
  return fail(501, "mock_not_implemented", `The mock API doesn't fake ${method} ${path} yet.`)
}
