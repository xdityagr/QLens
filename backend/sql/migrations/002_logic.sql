-- Database-side logic for the qlens metadata schema: triggers that keep derived columns correct
-- no matter which code path writes the data, and views that the API reads directly.

-- ---------------------------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------------------------

-- Stamps updated_at on every UPDATE, ignoring whatever the client sent. clock_timestamp() rather
-- than now(): now() is frozen at transaction start, so two updates in one transaction would
-- otherwise look simultaneous.
CREATE FUNCTION qlens.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE TRIGGER workspaces_touch BEFORE UPDATE ON qlens.workspaces
    FOR EACH ROW EXECUTE FUNCTION qlens.touch_updated_at();
CREATE TRIGGER datasets_touch BEFORE UPDATE ON qlens.datasets
    FOR EACH ROW EXECUTE FUNCTION qlens.touch_updated_at();
CREATE TRIGGER saved_queries_touch BEFORE UPDATE ON qlens.saved_queries
    FOR EACH ROW EXECUTE FUNCTION qlens.touch_updated_at();

-- Keeps the saved query's usage counters in step with its successful runs. Failed and timed-out
-- runs are history but do not count as a run of the query (the WHEN clause filters them out
-- before the function is even called).
CREATE FUNCTION qlens.record_query_run() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE qlens.saved_queries
       SET run_count        = run_count + 1,
           last_run_at      = NEW.created_at,
           last_duration_ms = NEW.duration_ms
     WHERE id = NEW.saved_query_id;
    RETURN NULL;   -- AFTER trigger: return value is ignored
END;
$$;

CREATE TRIGGER query_runs_record AFTER INSERT ON qlens.query_runs
    FOR EACH ROW WHEN (NEW.saved_query_id IS NOT NULL AND NEW.status = 'ok')
    EXECUTE FUNCTION qlens.record_query_run();

-- ---------------------------------------------------------------------------------------------
-- Views
-- ---------------------------------------------------------------------------------------------

-- One row per workspace for the workspace list: how far along it is and how much it has been used.
--   stage             'empty' until a dataset is imported, then the dataset's status
--   row_count/column_count   size of the imported dataset (NULL while empty)
--   table_count       tables in the applied proposal (0 until a design is applied)
--   last_activity_at  latest of: workspace edit, dataset edit, most recent query run
CREATE VIEW qlens.v_workspace_summary AS
SELECT w.id                                AS workspace_id,
       w.owner_id,
       w.name,
       w.created_at,
       COALESCE(d.status, 'empty')         AS stage,
       d.row_count,
       d.column_count,
       t.table_count,
       q.query_count,
       -- GREATEST ignores NULLs, so a workspace without a dataset or runs still gets a value.
       GREATEST(w.updated_at, d.updated_at, q.last_run_at) AS last_activity_at
FROM qlens.workspaces w
LEFT JOIN qlens.datasets d ON d.workspace_id = w.id
-- Aggregates without GROUP BY always return exactly one row, so these laterals never drop a workspace.
LEFT JOIN LATERAL (
    SELECT count(*) AS table_count
    FROM qlens.schema_proposals sp
    JOIN qlens.proposed_tables pt ON pt.proposal_id = sp.id
    WHERE sp.dataset_id = d.id AND sp.status = 'applied'
) t ON true
LEFT JOIN LATERAL (
    SELECT count(*) AS query_count, max(qr.created_at) AS last_run_at
    FROM qlens.query_runs qr
    WHERE qr.workspace_id = w.id
) q ON true;

-- Successful runs from the last 30 days that are in the slowest 10% of their workspace
-- (duration at or above the workspace's 90th percentile). p90_ms is that threshold.
CREATE VIEW qlens.v_slow_queries AS
WITH recent AS (
    SELECT id, workspace_id, sql_text, duration_ms, created_at
    FROM qlens.query_runs
    WHERE status = 'ok'
      AND duration_ms IS NOT NULL
      AND created_at >= now() - interval '30 days'
), threshold AS (
    SELECT workspace_id,
           percentile_cont(0.9) WITHIN GROUP (ORDER BY duration_ms) AS p90_ms
    FROM recent
    GROUP BY workspace_id
)
SELECT r.workspace_id,
       r.id AS run_id,
       r.sql_text,
       r.duration_ms,
       r.created_at,
       th.p90_ms
FROM recent r
JOIN threshold th USING (workspace_id)
WHERE r.duration_ms >= th.p90_ms;

-- Timing history of each saved query, one row per successful run, with window functions:
--   run_number     1, 2, 3, ... in time order
--   prev_ms        duration of the previous run (NULL for the first)
--   moving_avg_ms  average of this run and the four before it
-- id is a tiebreaker so runs with identical timestamps still get a stable order.
CREATE VIEW qlens.v_saved_query_trend AS
SELECT saved_query_id,
       id AS run_id,
       row_number() OVER (PARTITION BY saved_query_id ORDER BY created_at, id) AS run_number,
       created_at,
       duration_ms,
       lag(duration_ms) OVER (PARTITION BY saved_query_id ORDER BY created_at, id) AS prev_ms,
       avg(duration_ms) OVER (PARTITION BY saved_query_id ORDER BY created_at, id
                              ROWS BETWEEN 4 PRECEDING AND CURRENT ROW) AS moving_avg_ms
FROM qlens.query_runs
WHERE saved_query_id IS NOT NULL
  AND status = 'ok'
  AND duration_ms IS NOT NULL;
