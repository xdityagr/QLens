-- The Data step: rows of the applied tables can be added, edited and deleted from the UI, and a
-- trigger on every generated table records each change here. Conventions as in 001_schema.sql.

-- One row per INSERT, UPDATE or DELETE on a generated table (ws_<id>.<table>). before is the
-- old row (NULL for an INSERT), after the new one (NULL for a DELETE), both as JSON so the log
-- keeps working whatever columns the table has. Written only by qlens.log_row_change().
CREATE TABLE qlens.row_changes (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workspace_id bigint NOT NULL REFERENCES qlens.workspaces (id) ON DELETE CASCADE,
    table_name   text NOT NULL,
    op           text NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
    row_pk       bigint,
    before       jsonb,
    after        jsonb,
    changed_at   timestamptz NOT NULL DEFAULT now(),
    CHECK ((op = 'INSERT') = (before IS NULL) AND (op = 'DELETE') = (after IS NULL))
);
-- Serves "recent changes in this workspace" (the audit timeline, newest first), the count of
-- edits since the last apply, and the cascade from workspaces.
CREATE INDEX row_changes_workspace_idx ON qlens.row_changes (workspace_id, changed_at DESC);

-- AFTER ... FOR EACH ROW trigger function attached by Apply to every generated table. The
-- workspace comes from the schema name (ws_<id>); a table anywhere else is not logged.
CREATE FUNCTION qlens.log_row_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    ws_id bigint := substring(TG_TABLE_SCHEMA FROM '^ws_([0-9]+)$')::bigint;
    old_row jsonb;
    new_row jsonb;
BEGIN
    IF ws_id IS NULL THEN
        RETURN NULL;
    END IF;
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        old_row := to_jsonb(OLD);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        new_row := to_jsonb(NEW);
    END IF;
    INSERT INTO qlens.row_changes (workspace_id, table_name, op, row_pk, before, after)
    VALUES (ws_id, TG_TABLE_NAME, TG_OP, (coalesce(new_row, old_row) ->> 'id')::bigint, old_row, new_row);
    RETURN NULL;   -- the result of an AFTER trigger is ignored
END
$$;

-- Tables applied before this migration get the trigger too (Apply adds it to new ones).
DO $$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT n.nspname, c.relname
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN qlens.workspaces w ON n.nspname = 'ws_' || w.id
        WHERE c.relkind = 'r'
          AND NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND g.tgname = 'log_row_change')
    LOOP
        EXECUTE format('CREATE TRIGGER log_row_change AFTER INSERT OR UPDATE OR DELETE ON %I.%I '
                       'FOR EACH ROW EXECUTE FUNCTION qlens.log_row_change()', t.nspname, t.relname);
    END LOOP;
END
$$;
