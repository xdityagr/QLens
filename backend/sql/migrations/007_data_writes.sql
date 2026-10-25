-- The Data page's SQL tab runs a typed INSERT, UPDATE or DELETE as the workspace's own sandbox role,
-- which has no rights in the qlens schema. The audit trigger therefore runs as its owner (the app
-- role), so the change log is written whoever makes the change. search_path is pinned, as for any
-- SECURITY DEFINER function; the body already names qlens.row_changes in full.
-- Safe to expose: a trigger function cannot be called directly, and the sandbox role cannot create
-- triggers (it owns no tables and has no TRIGGER privilege).
ALTER FUNCTION qlens.log_row_change() SECURITY DEFINER SET search_path = pg_catalog, pg_temp;
-- Nobody needs to call it: Apply attaches it as its owner, and a trigger runs it without an EXECUTE check.
REVOKE EXECUTE ON FUNCTION qlens.log_row_change() FROM PUBLIC;
