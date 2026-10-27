# Deploying QLens

In production QLens runs as one container. FastAPI serves the API under `/api` and the built React app on every other
path, so the browser talks to a single origin and the session cookie stays first-party. On start the container runs
`python -m qlens.cloud_init`, which prepares the database and applies pending migrations, and then starts uvicorn on
`$PORT`. Both steps are idempotent, so the same command runs on every deploy.

Local development is unchanged: `scripts\dev.ps1`, Vite on 5173 proxying `/api` to uvicorn on 8000, settings in `backend\.env`.

## Settings (environment variables)

| Variable | Needed | Value |
| --- | --- | --- |
| `DATABASE_URL` | yes | `postgresql://user:password@host:port/dbname?sslmode=require` (`postgres://` is accepted too). Workspace sandbox connections reuse its host, port, database and SSL settings. |
| `SECRET_KEY` | yes | A long random string (`python -c "import secrets; print(secrets.token_hex(32))"`). **Never change it** once workspaces exist: each workspace role's password is derived from it. |
| `APP_ENV` | yes | `production`. The API then serves `frontend/dist` (the Docker image sets this already). |
| `COOKIE_SECURE` | yes | `true` (the site is served over HTTPS). |
| `GEMINI_API_KEY` | no | Turns on Ask AI and the Design assistant. Without it those features say they are off. |
| `GEMINI_MODEL` | no | Defaults to `gemini-3.5-flash`. |
| `ROLE_PREFIX` | no | Prefix of the per-workspace roles, default `qlens_ws_`. Roles are cluster-wide, so give each QLens installation sharing one server its own prefix. |
| `COOKIE_SAMESITE` | no | `lax` (default), `strict` or `none`. `none` forces Secure. Only needed for the cross-site setup described under Vercel. |
| `DB_POOL_MAX` | no | Size of the API's connection pool, default 10. |
| `PORT` | no | Set by the host; the image defaults to 8000. |

No `.env` file is read or needed in production; real environment variables always win over one anyway.

## Choosing a database

QLens needs more from PostgreSQL than most apps. For each workspace it runs `CREATE ROLE ... LOGIN PASSWORD ...`, grants
that role access to the workspace's schemas, and then **connects as that role** to run the user's SQL. So the database
user in `DATABASE_URL` must:

1. own the database (to create the `qlens` schema and the `pg_trgm` extension), and
2. have **CREATEROLE**, and the roles it creates must be able to log in over the network with a password.

Check point 2 in any SQL console connected as that user:

```sql
SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user;
```

It must return `true`. `cloud_init` runs the same check on every start and stops with a clear message if it fails, so a
wrong choice shows up in the deploy log instead of as a broken workspace later.

| Provider | Free tier | Notes |
| --- | --- | --- |
| **Render Postgres** | yes, but it expires | **Not usable on the free plan**: Render's managed users cannot run `CREATE ROLE` (users are managed only through the Render dashboard/API). |
| **Neon (used by `render.yaml`)** | yes, no expiry | The default owner role belongs to `neon_superuser`, which has CREATEROLE. Use the **direct** connection string (host without `-pooler`): the pooled endpoint does not accept the per-connection `search_path` option the sandbox sends. Keep `?sslmode=require`. |
| **Supabase** | yes | The `postgres` user has CREATEROLE, but the direct host is IPv6-only on the free plan and the poolers expect user names of the form `role.projectref`, which the per-workspace roles do not have. Not recommended without the paid IPv4 add-on. |

## Deploy on Render (Blueprint)

1. Create the Neon database first (next section) and copy its direct connection string.
2. The code is on GitHub (`main` branch of the repository). Render deploys that branch.
3. Render dashboard > **New > Blueprint** > connect the repository. Render reads `render.yaml` and proposes a web
   service `qlens` (Docker, free). Paste the Neon string for `DATABASE_URL`, and for `GEMINI_API_KEY` a key from
   <https://aistudio.google.com/apikey> (or leave it empty).
4. **Apply**. The first build takes a few minutes (Node build of the web app, then the Python image). The deploy log
   should end with `cloud_init: database ready (9 migration(s) applied ...)` and uvicorn listening.
5. Open `https://<service>.onrender.com`. `/api/health` should return `{"ok": true, "db": true}`.

### Creating the Neon database (do this first)

1. Sign up at <https://neon.tech> (free) > **New project**: Postgres 18 (or the newest offered), region close to your
   Render region (e.g. AWS Singapore for Render Singapore), database name `qlens`.
2. **Connect** > choose the database `qlens` and the default owner role > turn **Connection pooling OFF** > copy the
   connection string. It looks like
   `postgresql://<owner>:<password>@ep-xxxx-xxxx.<region>.aws.neon.tech/qlens?sslmode=require` - the host must **not**
   contain `-pooler`.
3. Optional check in Neon's SQL Editor: `SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user;` returns `true`.
4. Paste that string as `DATABASE_URL` when the Blueprint asks, or in Render > `qlens` > **Environment** for an existing
   service, then **Save** (Render redeploys). On start, `cloud_init` creates the `qlens` schema and the `pg_trgm`
   extension and applies all migrations.

If you created the Blueprint earlier with a Render Postgres `qlens-db`: set `DATABASE_URL` on the `qlens` service to the
Neon URL as above, then delete `qlens-db` in the Render dashboard (it is no longer referenced by `render.yaml`).

### Setting or changing GEMINI_API_KEY later

Render dashboard > `qlens` > **Environment** > add or edit `GEMINI_API_KEY` > Save. Render redeploys with the new value.

### Redeploying

`autoDeploy` is on, so every push to the deployed branch rebuilds and redeploys. To redeploy by hand: `qlens` >
**Manual Deploy > Deploy latest commit**. New migrations in `backend/sql/migrations` are applied automatically on start.

## Free-tier caveats

- **The web service sleeps.** A free Render web service stops after about 15 minutes without traffic. The next visit
  starts it again, which takes roughly a minute (the first request may time out; reload). Wake it a few minutes before
  a demo by opening `/api/health`.
- **Neon free compute suspends** after a few idle minutes; the first query afterwards takes a moment longer.
- **Small connection limits.** Each running query opens one extra connection as the workspace role (at most 3 per
  workspace). That is fine for a demo; lower `DB_POOL_MAX` if the provider's limit is tight.
- **Gemini free tier** is rate-limited per minute and per day; when it is hit the app says so (wait about a minute).

## Running the image locally

```powershell
docker build -t qlens .
docker run --rm -p 8000:8000 -e DATABASE_URL="postgresql://..." -e SECRET_KEY="..." -e COOKIE_SECURE=false qlens
```

`COOKIE_SECURE=false` only because `http://localhost` is not HTTPS. The local dev cluster listens on `localhost` only, so a
container cannot reach it; point `DATABASE_URL` at a cloud database instead. Without Docker, the same production setup
is: `npm run build` in `frontend`, then in `backend` set `APP_ENV=production` and run `uv run uvicorn qlens.main:app`.

## Optional: frontend on Vercel, API on Render

Not needed (the Render service already serves the web app), but possible. Deploy `frontend/` to Vercel (framework
Vite, output `dist`) with this `frontend/vercel.json`, replacing the host with your Render service:

```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://YOUR-SERVICE.onrender.com/api/:path*" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

The web app calls relative `/api/...` URLs, and Vercel proxies them, so the browser still sees one site and the
default `SameSite=Lax` cookie works. Keep `COOKIE_SECURE=true` on Render; `APP_ENV=production` is harmless there.

`COOKIE_SAMESITE=none` (which forces `Secure`) is only for a different setup, where the page on one site calls the API's
own `onrender.com` address directly. That would also need CORS with credentials, which QLens does not enable, and
browsers that block third-party cookies may refuse such a cookie anyway; prefer the rewrite. Note that Vercel gives up
on a proxied request after a timeout, so the first request after the Render service has slept may fail; reload.
