import { expect, test } from "vitest"
import { MOCK_DEMO, mockFetch } from "./mock"

// One shared in-memory state (no sessionStorage under node), so steps run in order.
test("mock API: auth gate, login, workspace CRUD", async () => {
  expect((await mockFetch("/api/workspaces", { method: "GET" })).status).toBe(401)
  expect((await mockFetch("/api/auth/login", { method: "POST", json: { email: MOCK_DEMO.email, password: "nope" } })).status).toBe(401)

  const login = await mockFetch("/api/auth/login", { method: "POST", json: { email: " Riya@Example.com", password: MOCK_DEMO.password } })
  expect(login.status).toBe(200)
  expect(login.body).toEqual({ id: 1, email: MOCK_DEMO.email, display_name: "Riya Sharma" })

  const list = await mockFetch("/api/workspaces", { method: "GET" })
  const names = (list.body as { name: string }[]).map((w) => w.name)
  expect(names[0]).toBe("Coaching fees") // most recent activity first
  expect(names).toHaveLength(4)

  const dup = await mockFetch("/api/workspaces", { method: "POST", json: { name: "coaching fees" } })
  expect(dup.status).toBe(409)

  const created = await mockFetch("/api/workspaces", { method: "POST", json: { name: "Mess menu" } })
  expect(created.status).toBe(201)
  const ws = created.body as { id: number; stage: string }
  expect(ws.stage).toBe("empty")

  expect((await mockFetch(`/api/workspaces/${ws.id}`, { method: "DELETE" })).status).toBe(204)
  expect((await mockFetch(`/api/workspaces/${ws.id}`, { method: "GET" })).status).toBe(404)

  expect((await mockFetch("/api/auth/logout", { method: "POST" })).status).toBe(204)
  expect((await mockFetch("/api/auth/me", { method: "GET" })).status).toBe(401)
}, 15000)
