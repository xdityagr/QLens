import psycopg
import pytest

from qlens import db
from qlens.config import get_settings
from qlens.query.sandbox import QueryError, run


def _raw(ws_id: int) -> psycopg.Connection:
    s = get_settings()
    return psycopg.connect(host=s.pg_host, port=s.pg_port, dbname=s.pg_dbname,
                           user=db.ws_role(ws_id), password=db.ws_password(ws_id))


def test_select_and_types(applied_fee):
    r = run(applied_fee.id, "SELECT 1.50::numeric AS n, DATE '2026-04-01' AS d, interval '1 day' AS i, "
                            "'\\x0102'::bytea AS b")
    assert r.rows == [["1.50", "2026-04-01", "1 day, 0:00:00", "\\x0102"]]
    assert [c["name"] for c in r.columns] == ["n", "d", "i", "b"]
    assert [c["type"] for c in r.columns] == ["numeric", "date", "interval", "bytea"]
    assert r.row_count == 1 and not r.truncated and r.duration_ms >= 0


def test_percent_arrays_jsonb_and_unrepresentable_dates(applied_fee):
    r = run(applied_fee.id, "SELECT 'abc' LIKE '%b%' AS m, ARRAY[1,2] AS a, '{\"k\": [1]}'::jsonb AS j, "
                            "'infinity'::date AS inf, 'infinity'::timestamptz AS tinf, NULL AS n")
    assert r.rows == [[True, [1, 2], {"k": [1]}, "infinity", "infinity", None]]


def test_reads_applied_tables(applied_fee):
    assert run(applied_fee.id, "SELECT count(*) AS n FROM students").rows[0][0] > 0
    # the src schema is on the search path too
    assert run(applied_fee.id, "SELECT count(*) FROM _staging").rows[0][0] > 0


def test_row_cap(applied_fee):
    r = run(applied_fee.id, "SELECT g FROM generate_series(1,1500) g")
    assert len(r.rows) == 1000 and r.truncated and r.row_count == 1000
    r = run(applied_fee.id, "SELECT g FROM generate_series(1,1500) g", max_rows=1500)
    assert len(r.rows) == 1500 and not r.truncated


def test_cannot_read_metadata_or_other_workspace(applied_fee, other_applied_ws):
    with pytest.raises(QueryError) as e:
        run(applied_fee.id, "SELECT * FROM qlens.users")
    assert e.value.code == "db_error" and e.value.sqlstate == "42501"
    with pytest.raises(QueryError) as e:
        run(applied_fee.id, f"SELECT * FROM ws_{other_applied_ws.id}.students")
    assert e.value.sqlstate == "42501"
    with pytest.raises(QueryError):
        run(applied_fee.id, f"SELECT * FROM ws_{other_applied_ws.id}_src._staging")


def test_privileges_hold_even_without_validator(applied_fee, other_applied_ws):
    with _raw(applied_fee.id) as c:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            c.execute("SELECT set_config('role','qlens_app',false)")
        c.rollback()
        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            c.execute("INSERT INTO students DEFAULT VALUES")
        c.rollback()
        # Even with read-only switched off the role can write only the generated tables (the Data page's
        # SQL tab): never the imported sheet, never DDL, never qlens or another workspace.
        c.execute("SET default_transaction_read_only = off")
        c.commit()
        for stmt in ("INSERT INTO _staging DEFAULT VALUES", "DELETE FROM _raw",
                     "CREATE TABLE public.x (a int)", "SELECT * FROM qlens.users",
                     "TRUNCATE students", "ALTER TABLE students ADD COLUMN x int",
                     f"SELECT * FROM ws_{other_applied_ws.id}.students"):
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                c.execute(stmt)
            c.rollback()


def test_locking_clause_fails_in_read_only_transaction(applied_fee):
    with pytest.raises(QueryError) as e:
        run(applied_fee.id, "SELECT * FROM students FOR UPDATE")
    assert e.value.code == "db_error"


def test_timeout(applied_fee):
    with pytest.raises(QueryError) as e:
        run(applied_fee.id, "SELECT pg_sleep(10)", timeout_ms=300)
    assert e.value.code == "timeout" and e.value.sqlstate == "57014"
    assert e.value.duration_ms is not None and e.value.duration_ms < 3000


def test_timeout_is_capped_at_5s(applied_fee):
    with pytest.raises(QueryError) as e:
        run(applied_fee.id, "SELECT pg_sleep(8)", timeout_ms=60_000)
    assert e.value.code == "timeout" and e.value.duration_ms < 7000


def test_db_error_has_sqlstate_and_position(applied_fee):
    with pytest.raises(QueryError) as e:
        run(applied_fee.id, "SELECT nope FROM students")
    assert e.value.code == "db_error" and e.value.sqlstate == "42703" and e.value.position == 8
    with pytest.raises(QueryError) as e:
        run(applied_fee.id, "SELECT 1/0")
    assert e.value.sqlstate == "22012" and e.value.position is None


def test_lab_target_uses_lab_schema(conn, applied_fee):
    db.create_ws_schema(conn, applied_fee.id, "lab")
    conn.execute(f"CREATE TABLE ws_{applied_fee.id}_lab.only_in_lab AS SELECT 7 AS x")
    conn.commit()
    assert run(applied_fee.id, "SELECT x FROM only_in_lab", target="lab").rows == [[7]]
    with pytest.raises(QueryError):
        run(applied_fee.id, "SELECT x FROM only_in_lab", target="main")
    with pytest.raises(QueryError):
        run(applied_fee.id, "SELECT count(*) FROM students", target="lab")


def test_connections_are_released(applied_fee):
    # CONNECTION LIMIT is 3: leaking a connection per run would fail well before this finishes.
    for _ in range(8):
        run(applied_fee.id, "SELECT 1")
    for _ in range(5):
        with pytest.raises(QueryError) as e:
            run(applied_fee.id, "SELECT nope")
        assert e.value.sqlstate == "42703"
    run(applied_fee.id, "SELECT 1")


def test_run_itself_refuses_a_second_statement(applied_fee):
    # Defence in depth: the validator already rejects this, but run() must not depend on it.
    for q in ("SELECT 1; SELECT 2", "SELECT 1; COMMIT; SELECT 2"):
        with pytest.raises(QueryError) as e:
            run(applied_fee.id, q)
        assert "multiple commands" in e.value.message


def test_connection_failures_do_not_leak_host_or_role(monkeypatch):
    # Pure: no database needed.
    settings = get_settings()

    def refuse(*a, **kw):
        raise psycopg.OperationalError(
            f'connection to server at "{settings.pg_host}" ({settings.pg_host}), port {settings.pg_port} failed: '
            f'FATAL: role "{db.ws_role(7)}" does not exist')

    monkeypatch.setattr(psycopg, "connect", refuse)
    with pytest.raises(QueryError) as e:
        run(7, "SELECT 1")
    assert e.value.code == "db_error"
    for secret in (settings.pg_host, str(settings.pg_port), db.ws_role(7)):
        assert secret not in e.value.message


def test_too_many_connections_is_friendly(monkeypatch):
    def refuse(*a, **kw):
        raise psycopg.errors.TooManyConnections(f'too many connections for role "{db.ws_role(7)}"')

    monkeypatch.setattr(psycopg, "connect", refuse)
    with pytest.raises(QueryError) as e:
        run(7, "SELECT 1")
    assert e.value.sqlstate == "53300"
    assert e.value.message == "Too many queries are running for this workspace — try again in a moment."
