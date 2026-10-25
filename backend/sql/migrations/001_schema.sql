-- QLens metadata schema.
--
-- Everything the application stores about users, workspaces, uploaded datasets, the analysis of
-- those datasets (keys, functional dependencies, duplicates), the proposed normalized design and
-- the query history lives in schema "qlens". The user's own data never lives here: each workspace
-- gets its own "ws_<id>" schema, created at runtime.
--
-- Conventions
--   * Surrogate keys are "id bigint GENERATED ALWAYS AS IDENTITY". Exceptions: sessions (the token
--     hash is the key), the junction tables (composite keys) and duplicate_values (composite key).
--   * Every timestamp is timestamptz NOT NULL DEFAULT now().
--   * Every column that will become a SQL identifier is checked against ^[a-z_][a-z0-9_]{0,62}$,
--     so it is always safe to quote and fits PostgreSQL's 63-byte identifier limit.
--   * Closed vocabularies are text + CHECK (x IN (...)); easier to evolve than enum types.
--   * Deleting a parent removes its children (ON DELETE CASCADE), so deleting a user, a workspace
--     or a dataset never leaves orphans. SET NULL is used only where history must survive.
--   * PostgreSQL does not index foreign keys automatically; each FK column below is either the
--     leading column of a UNIQUE/PRIMARY KEY constraint or has an index whose comment says why.

CREATE SCHEMA IF NOT EXISTS qlens;

-- ---------------------------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------------------------

CREATE TABLE qlens.users (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Stored lower-case so the UNIQUE constraint is also case-insensitive.
    email         text NOT NULL UNIQUE
                  CHECK (email = lower(email) AND position('@' in email) > 1),
    password_hash text NOT NULL,
    display_name  text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Server-side login sessions. Only the SHA-256 of the cookie token is stored, so a leaked
-- database cannot be replayed as live sessions.
CREATE TABLE qlens.sessions (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    user_id    bigint NOT NULL REFERENCES qlens.users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CHECK (expires_at > created_at)
);
-- Serves "log out everywhere" / session cleanup for one user, and the ON DELETE CASCADE from users.
CREATE INDEX sessions_user_id_idx ON qlens.sessions (user_id);

-- ---------------------------------------------------------------------------------------------
-- Workspaces and the imported dataset
-- ---------------------------------------------------------------------------------------------

CREATE TABLE qlens.workspaces (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_id   bigint NOT NULL REFERENCES qlens.users (id) ON DELETE CASCADE,
    name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),   -- maintained by touch_updated_at()
    -- The UNIQUE index also serves "list this user's workspaces" (leading column owner_id).
    UNIQUE (owner_id, name)
);

-- One imported spreadsheet per workspace (UNIQUE workspace_id); re-importing replaces it.
CREATE TABLE qlens.datasets (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id      bigint NOT NULL UNIQUE REFERENCES qlens.workspaces (id) ON DELETE CASCADE,
    original_filename text NOT NULL,
    source            text NOT NULL CHECK (source IN ('upload', 'sample')),
    file_size_bytes   integer NOT NULL CHECK (file_size_bytes >= 0),
    row_count         integer NOT NULL CHECK (row_count >= 0),
    column_count      smallint NOT NULL CHECK (column_count BETWEEN 1 AND 60),
    -- imported: raw data loaded; analyzed: dependencies found; applied: normalized tables built.
    status            text NOT NULL DEFAULT 'imported' CHECK (status IN ('imported', 'analyzed', 'applied')),
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()   -- maintained by touch_updated_at()
);

-- One row per spreadsheet column, with the profile computed at import time.
CREATE TABLE qlens.dataset_columns (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dataset_id     bigint NOT NULL REFERENCES qlens.datasets (id) ON DELETE CASCADE,
    ordinal        smallint NOT NULL CHECK (ordinal >= 1),
    name           text NOT NULL CHECK (name ~ '^[a-z_][a-z0-9_]{0,62}$'),  -- identifier in _raw/_staging
    label          text NOT NULL,                                          -- header as written in the file
    inferred_type  text NOT NULL CHECK (inferred_type IN ('integer', 'numeric', 'boolean', 'date', 'text')),
    null_count     integer NOT NULL DEFAULT 0 CHECK (null_count >= 0),
    distinct_count integer NOT NULL DEFAULT 0 CHECK (distinct_count >= 0),
    sample_values  text[] NOT NULL DEFAULT '{}',
    -- Both UNIQUE indexes lead with dataset_id, so they serve "columns of a dataset" (by name or
    -- in spreadsheet order) and the cascade from datasets.
    UNIQUE (dataset_id, name),
    UNIQUE (dataset_id, ordinal)
);

-- ---------------------------------------------------------------------------------------------
-- Analysis results: candidate keys, functional dependencies, duplicates, fixes
-- ---------------------------------------------------------------------------------------------

-- A candidate key is a set of 1..3 columns that identifies every row; the member columns are
-- in candidate_key_columns (many-to-many between keys and columns).
CREATE TABLE qlens.candidate_keys (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dataset_id bigint NOT NULL REFERENCES qlens.datasets (id) ON DELETE CASCADE,
    key_size   smallint NOT NULL CHECK (key_size BETWEEN 1 AND 3)
);
-- Serves "candidate keys of this dataset, smallest first" and the cascade from datasets.
CREATE INDEX candidate_keys_dataset_idx ON qlens.candidate_keys (dataset_id, key_size);

CREATE TABLE qlens.candidate_key_columns (
    key_id    bigint NOT NULL REFERENCES qlens.candidate_keys (id) ON DELETE CASCADE,
    column_id bigint NOT NULL REFERENCES qlens.dataset_columns (id) ON DELETE CASCADE,
    PRIMARY KEY (key_id, column_id)
);
-- Serves "which keys contain this column" and the cascade from dataset_columns.
CREATE INDEX candidate_key_columns_column_idx ON qlens.candidate_key_columns (column_id);

-- A functional dependency LHS -> rhs_column. The LHS (1 or 2 columns) is in fd_lhs_columns.
-- The measures say how well it holds: violating_rows is the number of rows that would have to
-- change for the dependency to hold exactly.
CREATE TABLE qlens.functional_dependencies (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dataset_id      bigint NOT NULL REFERENCES qlens.datasets (id) ON DELETE CASCADE,
    rhs_column_id   bigint NOT NULL REFERENCES qlens.dataset_columns (id) ON DELETE CASCADE,
    lhs_size        smallint NOT NULL CHECK (lhs_size BETWEEN 1 AND 2),
    row_count       integer NOT NULL CHECK (row_count >= 0),
    lhs_values      integer NOT NULL CHECK (lhs_values >= 0),       -- distinct LHS combinations
    repeated_groups integer NOT NULL CHECK (repeated_groups >= 0),  -- LHS combinations seen more than once
    violating_rows  integer NOT NULL CHECK (violating_rows >= 0),
    -- Derived values are generated so they can never disagree with violating_rows.
    is_exact        boolean GENERATED ALWAYS AS (violating_rows = 0) STORED,
    violation_ratio numeric GENERATED ALWAYS AS (violating_rows::numeric / NULLIF(row_count, 0)) STORED,
    -- false once the user rejects a dependency; only exact AND accepted ones feed the design.
    accepted        boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    CHECK (violating_rows <= row_count)
);
-- Serves "all dependencies of this dataset" (analysis page, design synthesis) and the cascade.
CREATE INDEX functional_dependencies_dataset_idx ON qlens.functional_dependencies (dataset_id);
-- Serves "dependencies that determine this column" and the cascade from dataset_columns.
CREATE INDEX functional_dependencies_rhs_idx ON qlens.functional_dependencies (rhs_column_id);

CREATE TABLE qlens.fd_lhs_columns (
    fd_id     bigint NOT NULL REFERENCES qlens.functional_dependencies (id) ON DELETE CASCADE,
    column_id bigint NOT NULL REFERENCES qlens.dataset_columns (id) ON DELETE CASCADE,
    PRIMARY KEY (fd_id, column_id)
);
-- Serves the cascade from dataset_columns and "dependencies whose LHS uses this column".
CREATE INDEX fd_lhs_columns_column_idx ON qlens.fd_lhs_columns (column_id);

-- A set of spellings in one column that probably mean the same thing ("NYC", "nyc ", ...).
CREATE TABLE qlens.duplicate_groups (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dataset_id      bigint NOT NULL REFERENCES qlens.datasets (id) ON DELETE CASCADE,
    column_id       bigint NOT NULL REFERENCES qlens.dataset_columns (id) ON DELETE CASCADE,
    canonical_value text NOT NULL,   -- the spelling every member would be merged into
    confidence      text NOT NULL CHECK (confidence IN ('same_normalized', 'similar')),
    max_similarity  real CHECK (max_similarity BETWEEN 0 AND 1),
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'merged', 'dismissed')),
    -- One group per canonical spelling per column. Its index leads with dataset_id, so it also
    -- serves "duplicate groups of this dataset" and the cascade from datasets.
    UNIQUE (dataset_id, column_id, canonical_value)
);
-- Serves the cascade from dataset_columns (the UNIQUE above cannot, column_id is not leading).
CREATE INDEX duplicate_groups_column_idx ON qlens.duplicate_groups (column_id);

CREATE TABLE qlens.duplicate_values (
    group_id  bigint NOT NULL REFERENCES qlens.duplicate_groups (id) ON DELETE CASCADE,
    value     text NOT NULL,
    row_count integer NOT NULL CHECK (row_count >= 0),
    PRIMARY KEY (group_id, value)
);

-- Audit log of every edit made to the _staging table (the _raw table is never modified).
CREATE TABLE qlens.dataset_fixes (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dataset_id    bigint NOT NULL REFERENCES qlens.datasets (id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('merge', 'fd_fix')),
    column_id     bigint NOT NULL REFERENCES qlens.dataset_columns (id) ON DELETE CASCADE,
    from_value    text,   -- NULL when the old cell was empty
    to_value      text,   -- NULL when the new cell is empty
    rows_affected integer NOT NULL CHECK (rows_affected >= 0),
    created_at    timestamptz NOT NULL DEFAULT now()
);
-- Serves "edit history of this dataset, newest first" and the cascade from datasets.
CREATE INDEX dataset_fixes_dataset_idx ON qlens.dataset_fixes (dataset_id, created_at DESC);
-- Serves the cascade from dataset_columns.
CREATE INDEX dataset_fixes_column_idx ON qlens.dataset_fixes (column_id);

-- ---------------------------------------------------------------------------------------------
-- Proposed normalized design
-- ---------------------------------------------------------------------------------------------

-- A synthesized design for a dataset: draft until applied; replaced designs are kept as
-- 'superseded' history. "Applied" is only allowed once the lossless-join check passed.
CREATE TABLE qlens.schema_proposals (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dataset_id         bigint NOT NULL REFERENCES qlens.datasets (id) ON DELETE CASCADE,
    status             text NOT NULL CHECK (status IN ('draft', 'applied', 'superseded')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    applied_at         timestamptz,
    -- Result of comparing the rebuilt join against _staging (EXCEPT ALL in both directions).
    lossless_ok        boolean,
    staging_rows       integer CHECK (staging_rows >= 0),
    reconstructed_rows integer CHECK (reconstructed_rows >= 0),
    mismatch_rows      integer CHECK (mismatch_rows >= 0),
    CHECK (status <> 'applied' OR lossless_ok IS TRUE)   -- IS TRUE: NULL (not checked) must not pass
);
-- At most one live (draft or applied) proposal per dataset, any number of superseded ones.
-- Also serves "the current proposal of this dataset" and the cascade from datasets.
CREATE UNIQUE INDEX schema_proposals_one_live_idx
    ON qlens.schema_proposals (dataset_id) WHERE status <> 'superseded';

CREATE TABLE qlens.proposed_tables (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    proposal_id bigint NOT NULL REFERENCES qlens.schema_proposals (id) ON DELETE CASCADE,
    ordinal     smallint NOT NULL CHECK (ordinal >= 1),
    name        text NOT NULL CHECK (name ~ '^[a-z_][a-z0-9_]{0,62}$'),
    kind        text NOT NULL CHECK (kind IN ('entity', 'fact')),
    color_index smallint NOT NULL CHECK (color_index BETWEEN 0 AND 7),   -- lane colour used everywhere in the UI
    explanation text NOT NULL,
    -- Leads with proposal_id: serves "tables of this proposal" and the cascade from proposals.
    UNIQUE (proposal_id, name)
);

CREATE TABLE qlens.proposed_columns (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_id            bigint NOT NULL REFERENCES qlens.proposed_tables (id) ON DELETE CASCADE,
    ordinal             smallint NOT NULL CHECK (ordinal >= 1),
    name                text NOT NULL CHECK (name ~ '^[a-z_][a-z0-9_]{0,62}$'),
    -- NULL for columns that have no spreadsheet origin (generated surrogate keys, foreign keys).
    -- SET NULL rather than CASCADE: losing a source column should not delete the design column.
    source_column_id    bigint REFERENCES qlens.dataset_columns (id) ON DELETE SET NULL,
    data_type           text NOT NULL CHECK (data_type IN ('bigint', 'numeric', 'boolean', 'date', 'text')),
    role                text NOT NULL CHECK (role IN ('pk', 'fk', 'attribute')),
    not_null            boolean NOT NULL,
    -- A foreign key points at another proposed table; a column that points at a deleted table
    -- is meaningless, so it goes with it.
    references_table_id bigint REFERENCES qlens.proposed_tables (id) ON DELETE CASCADE,
    -- A column is a foreign key exactly when it has a referenced table.
    CHECK ((role = 'fk') = (references_table_id IS NOT NULL)),
    -- Leads with table_id: serves "columns of this table" and the cascade from proposed_tables.
    UNIQUE (table_id, name)
);
-- Serves "which columns reference this table" (relationship lines in the diagram) and the cascade.
CREATE INDEX proposed_columns_references_idx ON qlens.proposed_columns (references_table_id)
    WHERE references_table_id IS NOT NULL;
-- Serves the ON DELETE SET NULL from dataset_columns.
CREATE INDEX proposed_columns_source_idx ON qlens.proposed_columns (source_column_id)
    WHERE source_column_id IS NOT NULL;

-- Unique constraints the generated table will carry (natural keys); members in the junction table.
CREATE TABLE qlens.proposed_unique_keys (
    id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    table_id           bigint NOT NULL REFERENCES qlens.proposed_tables (id) ON DELETE CASCADE,
    is_primary_natural boolean NOT NULL DEFAULT false   -- the natural key behind the surrogate primary key
);
-- Serves "unique keys of this table" and the cascade from proposed_tables.
CREATE INDEX proposed_unique_keys_table_idx ON qlens.proposed_unique_keys (table_id);

CREATE TABLE qlens.proposed_unique_key_columns (
    key_id    bigint NOT NULL REFERENCES qlens.proposed_unique_keys (id) ON DELETE CASCADE,
    column_id bigint NOT NULL REFERENCES qlens.proposed_columns (id) ON DELETE CASCADE,
    PRIMARY KEY (key_id, column_id)
);
-- Serves the cascade from proposed_columns.
CREATE INDEX proposed_unique_key_columns_column_idx ON qlens.proposed_unique_key_columns (column_id);

-- ---------------------------------------------------------------------------------------------
-- Query history and the performance lab
-- ---------------------------------------------------------------------------------------------

CREATE TABLE qlens.saved_queries (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id     bigint NOT NULL REFERENCES qlens.workspaces (id) ON DELETE CASCADE,
    title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
    sql_text         text NOT NULL,
    -- run_count / last_run_at / last_duration_ms are maintained by record_query_run().
    run_count        integer NOT NULL DEFAULT 0 CHECK (run_count >= 0),
    last_run_at      timestamptz,
    last_duration_ms numeric(12, 3),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),   -- maintained by touch_updated_at()
    -- Leads with workspace_id: serves "saved queries of this workspace" and the cascade.
    UNIQUE (workspace_id, title)
);

-- Every execution, successful or not. target says whether it ran on the main (normalized)
-- schema or in the performance lab copy.
CREATE TABLE qlens.query_runs (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id   bigint NOT NULL REFERENCES qlens.workspaces (id) ON DELETE CASCADE,
    -- Deleting a saved query keeps its history of runs.
    saved_query_id bigint REFERENCES qlens.saved_queries (id) ON DELETE SET NULL,
    sql_text       text NOT NULL,
    source         text NOT NULL CHECK (source IN ('typed', 'english', 'stepthrough', 'perf')),
    target         text NOT NULL CHECK (target IN ('main', 'lab')),
    status         text NOT NULL CHECK (status IN ('ok', 'error', 'timeout')),
    duration_ms    numeric(12, 3) CHECK (duration_ms >= 0),
    row_count      integer CHECK (row_count >= 0),
    error_message  text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    -- A run has an error message exactly when it did not succeed.
    CHECK ((status = 'ok') = (error_message IS NULL))
);
-- Serves the history page ("latest runs of this workspace"), the workspace summary (count and
-- latest run), v_slow_queries (recent window per workspace) and the cascade from workspaces.
CREATE INDEX query_runs_workspace_time_idx ON qlens.query_runs (workspace_id, created_at DESC);
-- Serves v_saved_query_trend ("runs of one saved query in time order") and the ON DELETE SET NULL
-- from saved_queries. Partial because most runs are ad hoc and have no saved query.
CREATE INDEX query_runs_saved_query_time_idx ON qlens.query_runs (saved_query_id, created_at)
    WHERE saved_query_id IS NOT NULL;

-- The English question behind a generated query run (at most one per run).
CREATE TABLE qlens.nl_questions (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    query_run_id bigint NOT NULL UNIQUE REFERENCES qlens.query_runs (id) ON DELETE CASCADE,
    question     text NOT NULL,
    explanation  text NOT NULL,
    model        text NOT NULL
);

-- EXPLAIN (ANALYZE, FORMAT JSON) output kept for the plan viewer and before/after comparisons.
CREATE TABLE qlens.explain_snapshots (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id bigint NOT NULL REFERENCES qlens.workspaces (id) ON DELETE CASCADE,
    query_run_id bigint REFERENCES qlens.query_runs (id) ON DELETE CASCADE,
    target       text NOT NULL CHECK (target IN ('main', 'lab')),
    plan         jsonb NOT NULL,
    planning_ms  numeric(12, 3) CHECK (planning_ms >= 0),
    execution_ms numeric(12, 3) CHECK (execution_ms >= 0),
    created_at   timestamptz NOT NULL DEFAULT now()
);
-- Serves "latest plans of this workspace" and the cascade from workspaces.
CREATE INDEX explain_snapshots_workspace_time_idx ON qlens.explain_snapshots (workspace_id, created_at DESC);
-- Serves "plan(s) of this run" and the cascade from query_runs. Partial: most snapshots may be standalone.
CREATE INDEX explain_snapshots_run_idx ON qlens.explain_snapshots (query_run_id)
    WHERE query_run_id IS NOT NULL;

-- One "does an index help?" experiment: the query is timed before and after creating the index.
CREATE TABLE qlens.index_experiments (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id bigint NOT NULL REFERENCES qlens.workspaces (id) ON DELETE CASCADE,
    table_name   text NOT NULL CHECK (table_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
    columns      text[] NOT NULL CHECK (cardinality(columns) BETWEEN 1 AND 3),
    index_name   text NOT NULL CHECK (index_name ~ '^[a-z_][a-z0-9_]{0,62}$'),
    ddl          text NOT NULL,
    before_ms    numeric(12, 3) NOT NULL CHECK (before_ms >= 0),
    after_ms     numeric(12, 3) NOT NULL CHECK (after_ms >= 0),
    runs         smallint NOT NULL CHECK (runs >= 1),   -- timing repetitions the figures are medians of
    speedup      numeric GENERATED ALWAYS AS (before_ms / NULLIF(after_ms, 0)) STORED,
    status       text NOT NULL CHECK (status IN ('kept', 'dropped')),
    created_at   timestamptz NOT NULL DEFAULT now()
);
-- Serves "experiments of this workspace, newest first" and the cascade from workspaces.
CREATE INDEX index_experiments_workspace_time_idx ON qlens.index_experiments (workspace_id, created_at DESC);
