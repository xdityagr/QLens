# QLens

QLens is an automated relational database design and normalization system. You upload a spreadsheet (CSV or XLSX) and it
loads the rows into PostgreSQL, discovers the functional dependencies hidden in the data with SQL queries, and finds
candidate keys and normal-form violations (2NF, 3NF, BCNF). It flags near-miss dependencies as data inconsistencies
you can fix, then synthesizes a lossless 3NF decomposition with primary keys, foreign keys and constraints. Applying the
design creates the real tables and checks the split is lossless by reconstructing the original rows with a natural join and
comparing them with `EXCEPT ALL`.

Once the schema exists, QLens is also a small lab for working with it. The Data page lets you browse and edit rows (with
filters, related records, CSV export and an audit log), run SELECT queries and confirmed INSERT/UPDATE/DELETE statements in
a sandbox, read EXPLAIN plans and try an index to see the speed-up, step through a query one clause at a time, and
(optionally) ask questions in English that Gemini turns into SQL. Every workspace gets its own PostgreSQL schema and role.
No ORM is used; all SQL is hand-written.

## Prerequisites

- Windows 11 with PowerShell
- PostgreSQL 18 installed (only its binaries are used; QLens runs its own private cluster, so the system server is untouched)
- Python 3.13 and [uv](https://docs.astral.sh/uv/)
- Node 24 and npm

## First-time setup

```powershell
cd backend
uv sync
uv run python -m qlens.pg_local init      # creates backend\.pgdata, listens on localhost:5544
uv run python -m qlens.pg_local start
uv run python -m qlens.setup_db           # creates the qlens and qlens_test databases, the app role, backend\.env
uv run python -m qlens.migrate            # creates the tables

cd ..\frontend
npm install
```

If PostgreSQL is not under `C:\Program Files\PostgreSQL\18\bin`, set the `PG_BIN` environment variable to its `bin` folder.

## Run

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

This starts the database cluster (if needed), applies migrations, then runs the API (uvicorn, port 8000) and the web app
(Vite, port 5173) as background jobs of that window. Open <http://localhost:5173>. Press Ctrl+C to stop both servers. The
database cluster keeps running; stop it with `cd backend; uv run python -m qlens.pg_local stop`.

`npm run dev:mock` (in `frontend`) runs the UI against a fake API with no backend, which is handy for design work.

## Optional: Gemini key

Ask AI and the Design assistant use Gemini. Add `GEMINI_API_KEY=...` to `backend\.env` (optionally `GEMINI_MODEL=...`) and
restart the API. Without a key those features say so and everything else works. The free tier allows roughly 20 requests per
day; when it runs out the app shows a rate-limit message and you can carry on with the SQL tab.

## Tests

```powershell
cd backend;  uv run pytest -q          # needs the database cluster running; rebuilds the qlens_test schema
cd frontend; npx vitest run
cd frontend; npx tsc -b; npm run build
```

Do not run two `pytest` sessions at once: they share the `qlens_test` schema.

## Demo walkthrough (viva)

1. **Landing** page, then **Sign up** and open the dashboard. Create a workspace with **Try a sample** and pick the fee register
   (3000 rows: a flat sheet of 300 students x 10 months with planted mistakes).
2. **Analyze.** Show the discovered functional dependencies (for example `student_name -> batch` and `batch -> teacher`), the
   candidate keys and the normal-form violations. Point out the inconsistencies (for example `student_phone -> student_name` broken by 8 rows with odd spellings; approximate FDs, a few rows that break an
   otherwise exact rule), fix them, then **Accept all**.
3. **Design.** The ER canvas shows the proposed 3NF tables. Rename a table (for example `teachers` to `staff`) and click **Apply design**. QLens
   creates the tables and reports the lossless check (`EXCEPT ALL` both ways returns 0 rows).
4. **Data > Browse.** Add a student. Add the same name again to trigger the UNIQUE constraint card. Add a fee for a student that
   does not exist to trigger the foreign key card. Open a row to show related records; export CSV; show the audit log.
5. **Data > SQL.** Run a join across the new tables. Select `SELECT * FROM fee_register WHERE fee_paid = 2100`, click
   **Explain & speed up**, read the plan (Seq Scan), try the suggested index and compare timings. Run a GROUP BY query and use
   **Step through** to see each clause's intermediate result. Run an `UPDATE` and confirm it in the dialog.
6. **Data > Ask AI** (needs the key; otherwise it explains why it is off), then **History** to show saved and past runs.

## Troubleshooting

- **Port 5544 in use / cluster will not start.** Run `uv run python -m qlens.pg_local status`. If another process holds 5544,
  stop it, or look at `backend\.pgdata\server.log`. A stale `postmaster.pid` after a crash is removed by starting the cluster again.
- **Port 8000 or 5173 in use.** `scripts\dev.ps1` refuses to start and names the port. Find the owner with
  `Get-NetTCPConnection -LocalPort 5173` and stop it.
- **Ask AI or the assistant shows "rate limited" (HTTP 429).** The Gemini free-tier quota is used up; wait for it to reset or use a
  different key. Nothing else is affected.
- **`pytest` hangs or errors on connect.** The cluster is not running; start it with `pg_local start`.
