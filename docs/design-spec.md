# QLens — Design Document

Date: 2026-10-25
Status: Approved by user 2026-10-25

## 1. Intent and the why

QLens turns a messy spreadsheet into a properly normalized relational database, then helps the
user ask questions of it and understand (and speed up) the SQL that answers them.

It is the student's RDBMS lab project (B.Tech, Manipal University Jaipur, Dept. of AI & ML). A
formal project report will be written **after** the app is built, following
`RDBMS_Project_Report_Format.docx` (Cover, Abstract, ToC, Lists of Figures/Tables, Introduction,
Scope, Product Scenarios, Requirement Analysis, Functional / Non-functional Requirements, Use Cases,
SE Methodologies, System Design, Design Goals, System Architecture, Detailed Design, Conclusion,
References, Appendix). The samples in `Samples/` show the expected depth (architecture diagrams,
ER diagrams, screenshots, SQL listings). They must **not** be copied; QLens should clearly exceed them
in originality and depth of RDBMS concepts.

**The real problem.** Small businesses and offices (a coaching institute's fee register, a kirana
shop's sales sheet, a hostel mess register) run on one ever-growing Excel sheet. Over time they hit
the classic anomalies without knowing the name for them:

- update anomaly — a teacher's phone number changes and must be edited in hundreds of rows;
- inconsistency / duplicates — "Riya Sharma" vs "riya sharma" counted as two students;
- simple questions ("who hasn't paid for October?") take an hour of filtering.

QLens reads the actual data, discovers which columns determine which (functional dependencies),
finds candidate keys and near-duplicates, proposes a 3NF schema with an ER diagram, and with one click
creates real tables with keys and foreign keys and migrates the data. Afterwards the user can ask
questions in plain English or SQL, step through how a query processes rows, and see the real
PostgreSQL execution plan with index suggestions and before/after timings.

**Users.** (1) Small business owners / office staff with messy sheets. (2) Developers migrating
legacy CSV/Excel data into an app database (QLens proposes schema + generates migration SQL).
(3) Students learning normalization and query execution using their own data.

**Gap it fills.** Airtable / NocoDB / Baserow give a database-like UI but the user must design the
tables. ChatGPT-style tools answer questions about a file but leave no lasting, correct database.
Nothing usable automatically restructures messy data into a normalized schema for non-experts.

## 2. Goals

1. Import a CSV or XLSX file (single sheet) and infer column types, null counts and distinct counts.
2. Discover functional dependencies from the data, **using SQL itself** (GROUP BY / COUNT DISTINCT
   checks against a staged raw table), including *approximate* FDs that hold for most rows, and list the
   violating rows as data inconsistencies.
3. Discover candidate keys (single and composite up to 3 columns).
4. Detect near-duplicate text values (e.g. names differing in case/spacing/typos) using `pg_trgm`
   similarity, and let the user merge them before building tables.
5. Propose a 3NF decomposition (Bernstein synthesis from a minimal cover), shown as an interactive ER
   diagram with an explanation in plain words ("Teacher Phone depends only on Teacher, so it moves to a
   Teachers table"). User can rename tables/columns before applying.
6. Apply the design in one transaction: create a per-workspace schema with tables, PKs, FKs,
   NOT NULL / UNIQUE constraints, migrate the data, and **verify the decomposition is lossless** by
   joining the new tables back and comparing to the original rows. Show the generated DDL/DML so a
   developer can copy it.
7. Query workspace: SQL editor with results grid, run under a sandboxed role.
8. Plain-English to SQL (optional, requires an LLM API key): question + workspace schema →
   SQL + plain-language explanation; the SQL is shown, validated as a single SELECT, then run.
9. Step-through visualizer for single SELECT statements: show intermediate results stage by stage —
   FROM/JOIN → WHERE → GROUP BY → HAVING → SELECT → ORDER BY/LIMIT — with row counts at each stage.
10. Performance lab: run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`, render the plan as a visual tree
    (node type, estimated vs actual rows, time, cost; slowest nodes highlighted). Suggest indexes for
    sequential scans with filters/join keys; "Try it" creates the index, re-runs the query several times,
    and records before/after timings. A "scale up data" action multiplies table rows with
    `generate_series` so index effects are visible on small sample files.
11. Saved queries and full run history (SQL, source = typed / english, duration, rows, status, error).
12. Bundled sample datasets with deliberate anomalies so the demo works without the user's own file:
    coaching-institute fee register (headline demo), kirana shop sales register, and one more.
13. Simple local accounts (email + password) so data is per user and the report has a real
    users → workspaces → datasets model.

## 3. Non-goals

- Live multi-user collaboration, mobile app, payments.
- Other database engines (MySQL, SQLite, etc.) — PostgreSQL only.
- Multi-sheet workbooks, files over ~20 MB / ~100k rows.
- Step-through for non-SELECT statements, CTE-heavy or window-function-heavy queries (show
  "step-through not available for this query" instead).
- Production-grade multi-tenant hardening for a public internet deployment. The sandbox must be
  sound for a local demo; public hosting is a later, separate decision.
- Writes from the query editor (INSERT/UPDATE/DELETE/DDL). The editor is read-only; only the app's
  own flows (apply design, merge duplicates, create index, scale data) change user tables.

## 4. Anti-goals (would be failure even if it "works")

- The report claims features that don't actually work. Every feature in the report must be
  demonstrable and screenshotted from the running app.
- An ORM that hides the SQL. The app's value and the report's marks come from visible, hand-written
  SQL: constraints, transactions, PL/pgSQL, views, dynamic SQL, catalog queries, EXPLAIN.
- A templated-looking UI. It should look like a real, polished product in screenshots.
- A normalization result that is wrong on textbook cases (must pass known FD/3NF examples in tests).
- A user query able to touch QLens's own tables or other workspaces' data.

## 5. Constraints

- Runs locally on the student's Windows 11 laptop: Python 3.13, Node 24 (frontend build), PostgreSQL 18 (installed natively,
  `psql` available), Docker also available. No paid services required except the optional LLM API.
- PostgreSQL is the system of record for both QLens's own data and user workspaces.
- Must produce good report material: an ER diagram of QLens's own schema, an architecture diagram,
  flow/sequence diagrams for import → analyze → apply and for query execution, screenshots of each
  screen, and representative SQL listings.

## 6. Decisions already made

- Name: **QLens**. (User's decision.)
- Project idea: the spreadsheet → normalized database + query/plan understanding tool described above.
  (User's decision.)
- **Backend in Python**, SQL wherever it fits. (User's decision.)
- **Visual design** (User's decision): light and dark themes, dark is **pure black** (`#000`); modern and
  minimal — no clutter, no "slap"; beautiful with subtle **noise/grain gradients**; good modern typography
  with **Space Grotesk**; a consistent colour scheme with a **GitLens-like aesthetic** (developer-tool feel,
  vivid lane colours on a dark canvas, like GitLens's commit graph).
- The following are **my calls**:
  - Backend: **FastAPI** (Python 3.13) with **psycopg 3** and hand-written SQL; schema managed by plain
    numbered `.sql` migration files. No ORM. Tests with pytest.
  - Frontend: **React + Vite + TypeScript + Tailwind CSS**, talking to the FastAPI JSON API.
  - Step-through SQL parsing with **pglast** (Python binding of the real Postgres parser, libpg_query).
  - Typography: Space Grotesk for UI and headings; a monospace (e.g. JetBrains Mono) for SQL, column
    names and numbers.
  - Colour system: neutral black/white canvas plus a small set of GitLens-style "lane" colours (blue,
    purple, pink, orange, green, teal) reused consistently — the same table keeps the same colour across
    the ER diagram, the dependency list, the step-through and the plan tree. Grain/noise gradients only
    as quiet background accents (headers, empty states, sign-in), never behind data.
  - QLens's own tables live in a `qlens` schema. Each workspace's user tables live in their own schema
    (`ws_<id>`); raw imported data is staged in a staging table inside that schema.
  - User queries run as a dedicated low-privilege role (`qlens_sandbox`) that has USAGE/SELECT only on
    the current workspace schema, with `search_path` set to that schema, inside a READ ONLY transaction
    with `statement_timeout` (≈5 s) and a result row cap (≈1000 rows returned to the UI).
  - English → SQL uses an LLM API, behind an env var; the app is fully usable without it.
  - Auth: email + password (bcrypt hash), sessions stored in Postgres, httpOnly cookie.

### 6.1 Further calls settled after design review (my calls)

- **Inconsistencies are resolved before apply.** The import keeps an untouched raw copy
  (`_raw`) and a working `_staging` copy. Approximate dependencies show their violating rows on the
  Analyze screen with a suggested fix (the most common value, e.g. the teacher's most frequent phone),
  which the user can accept in one click ("Accept all suggestions") or edit per row. Merging
  near-duplicates and fixing violations edit `_staging` only. An approximate dependency feeds the design
  only after its violations are fixed; otherwise it is ignored.
- **Lossless check compares against the cleaned `_staging` data, as a multiset**: the joined-back result
  must equal `_staging` row-for-row including counts (`EXCEPT ALL` both ways). Fully duplicated rows are
  treated as real repeats and kept (the fact/transaction table gets a surrogate PK so repeats are legal).
- **Light review of dependencies.** Discovery filters out noise automatically (dependencies whose LHS is
  a candidate key, constant columns, dependencies only on numeric measure columns such as amounts, and
  ones supported by too few distinct LHS values). The remaining dependencies are listed in plain English
  with a checkbox each, pre-checked. Unchecking one re-runs the synthesis. Keys are shown, not edited.
- **One workspace = one imported dataset = one schema `ws_<id>`.** Re-analyze, edit and re-apply is
  allowed: re-apply drops and recreates the generated tables in one transaction. Saved queries are kept
  as text (they may fail if they reference renamed tables, which shows as a normal error). Run history,
  plans and index experiments are kept as historical records.
- **Performance lab works on a throwaway copy.** "Scale up data" and "Try index" operate on a lab schema
  `ws_<id>_lab`, cloned from the workspace tables on demand and resettable. The user's real normalized
  tables are never filled with synthetic rows or extra indexes.
- **Sandbox isolation is per workspace.** One NOLOGIN role per workspace (`qlens_ws_<id>`) gets USAGE and
  SELECT only on its own schemas; the query runner uses `SET LOCAL ROLE` to that role inside a READ ONLY
  transaction, so schema-qualified access to other schemas or to `qlens.*` is denied by privileges, not
  only by `search_path`.

## 7. RDBMS concepts the build must visibly use (report material)

The QLens metadata schema (`qlens`) should itself be a good, normalized design that the report can
present. Expected entities (builder may refine names/columns): users, sessions, workspaces, datasets,
dataset_columns, functional_dependencies (+ a junction table for multi-column LHS),
candidate_keys, duplicate_groups / duplicate_values, schema_proposals, proposed_tables,
proposed_columns, saved_queries, query_runs, explain_snapshots (plan as JSONB),
index_experiments (before/after timings).

Must appear somewhere real in the app (not just in the report):

- PK, FK (with sensible ON DELETE behaviour), UNIQUE, NOT NULL, CHECK constraints.
- At least one PL/pgSQL function using dynamic SQL safely (`format()` with `%I`/`%L`) — e.g. the FD
  check `qlens.check_fd(schema, table, lhs text[], rhs text)` returning violation counts.
- At least one trigger (e.g. `updated_at` maintenance, or recording query-run stats).
- Views (e.g. per-workspace summary, recent slow queries) and at least one query using window functions
  (e.g. performance trend per saved query).
- Explicit transactions (apply-design is all-or-nothing; rollback on failure leaves no partial schema).
- Indexes on QLens's own hot paths (e.g. `query_runs (workspace_id, created_at DESC)`), justified.
- Roles and GRANTs for the sandbox; `pg_trgm` extension; system catalog / `information_schema`
  queries to read workspace schemas; `EXPLAIN ANALYZE` JSON.
- Lossless-join verification after decomposition.

## 8. Screens (demo order)

1. Sign in / sign up.
2. Workspaces dashboard (list, create, open sample dataset).
3. Import — upload file, preview, inferred types.
4. Analyze — data health: dependencies found (exact & approximate), candidate keys, inconsistencies,
   near-duplicates with merge actions; plain-language explanations of each finding.
5. Design — proposed 3NF schema as an ER diagram with rename controls, explanation of each split,
   generated SQL; "Apply" → progress → lossless check result.
6. Query — SQL editor + "Ask in English" box, results grid, step-through visualizer panel.
7. Performance — plan tree, index suggestions, try-index with before/after chart, scale-up data.
8. History & saved queries.

## 9. Testing expectations

- Unit tests for the pure algorithms: FD minimal cover, attribute closure, candidate key discovery,
  3NF synthesis — using textbook examples with known answers.
- Integration tests against a local test database for: FD discovery via SQL, apply-design transaction
  + lossless check, sandbox isolation (a sandbox query cannot read `qlens.*` or another workspace,
  cannot write), statement timeout.
- Manual end-to-end walkthrough of the headline demo (fee register) before the report is written.

## 10. Left to the builder

- Exact table/column names in the `qlens` schema; FD search limits (LHS size, approximate-FD
  threshold, sampling for large files); naming heuristics for proposed tables; surrogate vs natural keys
  in generated tables (recommendation: surrogate integer PK + UNIQUE on the natural key).
- Library choices: CSV/XLSX parsing, SQL editor component (e.g. CodeMirror), diagram library
  (e.g. React Flow), charting, password hashing.
- LLM model choice and prompt design for English → SQL.
- Exact palette values and component styling, within the visual direction in section 6.
- Database bootstrap/migration scripts and a one-command local setup.

## 11. After the build (separate step)

Write the project report (DOCX, following the format file) using real screenshots, the QLens schema
ER diagram, architecture and flow diagrams, SQL listings and test results. Planned after the app works.

## 12. Build priority (deadline not given — my call)

Build in this order so a complete demo exists as early as possible:
1. Foundation: DB migrations, auth, workspaces, visual design system (both themes).
2. Core flow: import → analyze (profiling, FDs, keys, inconsistencies, near-duplicates) → design (3NF + ER)
   → apply (transaction + lossless check).
3. Query editor with sandbox, saved queries and history.
4. Performance lab (EXPLAIN tree, index suggestions, lab copy, scale-up).
5. Step-through visualizer.
6. English → SQL (optional, needs API key).
Cut from the bottom if time runs short.

## 13. Scope additions requested by the user (2026-10-25, during the build)

- **Report in parallel:** the project report is written alongside the build in LaTeX (MiKTeX is installed),
  following `RDBMS_Project_Report_Format.docx`, with TikZ diagrams (architecture, ER of the `qlens` schema,
  flowcharts, sequence diagrams, use cases). Screenshots are added once the screens exist. Only verified features
  may be described as implemented.
- **Motion:** micro-animations across the UI, subtle moving/animated grain-gradient backgrounds, and animated
  entrances for diagrams (ER diagram, plan tree, step-through, flow visuals). Must respect `prefers-reduced-motion`
  and never hurt readability of data.
- **Agentic chat (replaces the plain English→SQL box of goal 8):** a chat assistant per workspace powered by the
  Gemini API (key supplied by the user in `backend/.env` as `GEMINI_API_KEY`). It uses tool calls against the
  workspace — describe schema, run read-only SQL through the sandbox, explain a query plan, explain a design
  decision — shows the SQL it ran, and persists conversations in the `qlens` schema. Fully optional: without a key
  the UI says so plainly.
- **Writes from the SQL editor (reverses the §3 non-goal):** the user asked for data editing, so the Data page's
  SQL tab runs a confirmed single INSERT, UPDATE or DELETE on the generated tables, as one transaction under the
  workspace role's DML grants (DDL stays refused; SELECTs stay read-only).

### 13.1 Design canvas + agentic assistant (user's vision, 2026-10-25)

- The Design step is a full-height canvas with a faint dot-grid background showing the proposed ER diagram
  (draggable tables, lane-coloured, FK edges), with a floating command/chat bar at the bottom.
- One input, two intents, decided by the model through tool use (Gemini function calling):
  - **Question** ("why is teacher_phone in teachers?", "does batch decide fee?") → a chat sidebar slides open and
    the answer streams in, showing any SQL/tool results used.
  - **Rework** ("rename students to learners", "batch doesn't really decide teacher, undo that",
    "move X to Y") → the assistant calls *validated* edit tools on the draft proposal; the canvas animates the
    change (tables placing in, moving, fading out, edges re-routing) and a compact "2 changes · Undo" toast
    appears without opening the sidebar.
- Tools are the only way the model acts; every tool is validated server-side with SQL. Initial tool set:
  describe_schema / describe_proposal, check_dependency(lhs, rhs) via `qlens.check_fd`, run_sql (read-only
  sandbox), explain_query, rename_table, rename_column, set_dependency_accepted (re-synthesizes the proposal),
  and move_column(column, to_table) only when `check_fd(to_table determinant → column)` is exact. Edits create a
  new draft version so they are undoable. The model cannot write arbitrary SQL.
- The same assistant is available on the Query screen (asks/answers, writes and runs read-only SQL).
- Conversations, messages and tool calls are persisted in the `qlens` schema.
