"""Behaviour of the qlens metadata schema: constraints, triggers and views, against real Postgres."""
from datetime import datetime, timedelta, timezone

import pytest
from psycopg import errors


def _user(conn, email="a@x.com"):
    return conn.execute(
        "INSERT INTO qlens.users (email, password_hash, display_name) VALUES (%s, 'h', 'Ada') RETURNING id",
        (email,)).fetchone()["id"]


def _workspace(conn, owner_id=None, name="ws"):
    owner_id = owner_id or _user(conn)
    return conn.execute(
        "INSERT INTO qlens.workspaces (owner_id, name) VALUES (%s, %s) RETURNING id",
        (owner_id, name)).fetchone()["id"]


def _dataset(conn, workspace_id=None, status="imported"):
    workspace_id = workspace_id or _workspace(conn)
    return conn.execute(
        """INSERT INTO qlens.datasets (workspace_id, original_filename, source, file_size_bytes,
                                       row_count, column_count, status)
           VALUES (%s, 'f.csv', 'upload', 100, 50, 4, %s) RETURNING id""",
        (workspace_id, status)).fetchone()["id"]


def _column(conn, dataset_id, ordinal=1, name="c1"):
    return conn.execute(
        """INSERT INTO qlens.dataset_columns (dataset_id, ordinal, name, label, inferred_type)
           VALUES (%s, %s, %s, %s, 'text') RETURNING id""",
        (dataset_id, ordinal, name, name.upper())).fetchone()["id"]


def _proposal(conn, dataset_id, status="draft", lossless_ok=None):
    return conn.execute(
        "INSERT INTO qlens.schema_proposals (dataset_id, status, lossless_ok) VALUES (%s, %s, %s) RETURNING id",
        (dataset_id, status, lossless_ok)).fetchone()["id"]


def _proposed_table(conn, proposal_id, ordinal=1, name="t1"):
    return conn.execute(
        """INSERT INTO qlens.proposed_tables (proposal_id, ordinal, name, kind, color_index, explanation)
           VALUES (%s, %s, %s, 'entity', 0, 'why') RETURNING id""",
        (proposal_id, ordinal, name)).fetchone()["id"]


def _saved_query(conn, workspace_id, title="q"):
    return conn.execute(
        "INSERT INTO qlens.saved_queries (workspace_id, title, sql_text) VALUES (%s, %s, 'SELECT 1') RETURNING id",
        (workspace_id, title)).fetchone()["id"]


def _run(conn, workspace_id, duration, saved_query_id=None, status="ok", created_at=None):
    err = None if status == "ok" else "boom"
    return conn.execute(
        """INSERT INTO qlens.query_runs (workspace_id, saved_query_id, sql_text, source, target, status,
                                         duration_ms, row_count, error_message, created_at)
           VALUES (%s, %s, 'SELECT 1', 'typed', 'main', %s, %s, 1, %s, COALESCE(%s, now())) RETURNING id""",
        (workspace_id, saved_query_id, status, duration, err, created_at)).fetchone()["id"]


def _expect(conn, exc, stmt, params=()):
    # A savepoint per expected failure keeps the surrounding test transaction usable.
    with pytest.raises(exc):
        with conn.transaction():
            conn.execute(stmt, params)


def test_email_must_be_lowercase(conn):
    _expect(conn, errors.CheckViolation,
            "INSERT INTO qlens.users (email, password_hash, display_name) VALUES ('A@x.com', 'h', 'Ada')")


def test_one_draft_and_one_applied_proposal_per_dataset(conn):
    ds = _dataset(conn)
    _proposal(conn, ds, "draft")
    _expect(conn, errors.UniqueViolation,
            "INSERT INTO qlens.schema_proposals (dataset_id, status) VALUES (%s, 'draft')", (ds,))
    # The applied design stays applied while a new draft is edited.
    _proposal(conn, ds, "applied", lossless_ok=True)
    _expect(conn, errors.UniqueViolation,
            "INSERT INTO qlens.schema_proposals (dataset_id, status, lossless_ok) VALUES (%s, 'applied', true)",
            (ds,))
    # Superseded proposals are history and may pile up.
    _proposal(conn, ds, "superseded")
    _proposal(conn, ds, "superseded")


def test_applied_proposal_requires_lossless(conn):
    ds = _dataset(conn)
    _expect(conn, errors.CheckViolation,
            "INSERT INTO qlens.schema_proposals (dataset_id, status, lossless_ok) VALUES (%s, 'applied', false)",
            (ds,))
    # Not yet checked (NULL) is not good enough either.
    _expect(conn, errors.CheckViolation,
            "INSERT INTO qlens.schema_proposals (dataset_id, status, lossless_ok) VALUES (%s, 'applied', NULL)",
            (ds,))
    _proposal(conn, ds, "applied", lossless_ok=True)


def test_fk_column_requires_reference(conn):
    t = _proposed_table(conn, _proposal(conn, _dataset(conn)))
    ins = """INSERT INTO qlens.proposed_columns (table_id, ordinal, name, data_type, role, not_null, references_table_id)
             VALUES (%s, 1, 'x_id', 'bigint', %s, true, %s)"""
    _expect(conn, errors.CheckViolation, ins, (t, "fk", None))
    _expect(conn, errors.CheckViolation, ins, (t, "attribute", t))
    conn.execute(ins, (t, "fk", t))


def test_fd_generated_columns(conn):
    ds = _dataset(conn)
    col = _column(conn, ds)
    ins = """INSERT INTO qlens.functional_dependencies
                 (dataset_id, rhs_column_id, lhs_size, row_count, lhs_values, repeated_groups, violating_rows)
             VALUES (%s, %s, 1, %s, 5, 3, %s) RETURNING is_exact, violation_ratio"""
    exact = conn.execute(ins, (ds, col, 10, 0)).fetchone()
    assert exact["is_exact"] is True and exact["violation_ratio"] == 0
    approx = conn.execute(ins, (ds, col, 10, 1)).fetchone()
    assert approx["is_exact"] is False and float(approx["violation_ratio"]) == pytest.approx(0.1)
    empty = conn.execute(ins, (ds, col, 0, 0)).fetchone()
    assert empty["violation_ratio"] is None  # NULLIF guards the division


def test_query_run_trigger_updates_saved_query(conn):
    ws = _workspace(conn)
    sq = _saved_query(conn, ws)
    _run(conn, ws, 12.5, sq)
    _run(conn, ws, 20.0, sq)
    _run(conn, ws, 99.0, sq, status="error")
    _run(conn, ws, 1.0)  # ad-hoc run, not tied to the saved query
    row = conn.execute("SELECT run_count, last_duration_ms, last_run_at FROM qlens.saved_queries WHERE id=%s",
                       (sq,)).fetchone()
    assert row["run_count"] == 2
    assert float(row["last_duration_ms"]) == 20.0
    assert row["last_run_at"] is not None


def test_touch_updated_at_overrides_client_value(conn):
    ws = _workspace(conn)
    ds = _dataset(conn, ws)
    sq = _saved_query(conn, ws)
    # A client-supplied updated_at must be ignored: the trigger always stamps the real time.
    for table, row_id in (("workspaces", ws), ("datasets", ds), ("saved_queries", sq)):
        conn.execute(f"UPDATE qlens.{table} SET updated_at = '2000-01-01' WHERE id = %s", (row_id,))
        year = conn.execute(f"SELECT extract(year FROM updated_at) AS y FROM qlens.{table} WHERE id = %s",
                            (row_id,)).fetchone()["y"]
        assert year >= 2026, table


def test_saved_query_trend_window(conn):
    ws = _workspace(conn)
    sq = _saved_query(conn, ws)
    base = datetime(2026, 1, 1, tzinfo=timezone.utc)
    for i, d in enumerate([10, 20, 30]):
        _run(conn, ws, d, sq, created_at=base + timedelta(minutes=i))
    rows = conn.execute(
        "SELECT run_number, prev_ms, moving_avg_ms FROM qlens.v_saved_query_trend "
        "WHERE saved_query_id=%s ORDER BY run_number", (sq,)).fetchall()
    assert [r["run_number"] for r in rows] == [1, 2, 3]
    assert [None if r["prev_ms"] is None else float(r["prev_ms"]) for r in rows] == [None, 10, 20]
    assert [float(r["moving_avg_ms"]) for r in rows] == [10, 15, 20]


def test_slow_queries_view(conn):
    ws = _workspace(conn)
    for d in range(1, 11):
        _run(conn, ws, d * 10)
    _run(conn, ws, 5000, created_at=datetime.now(timezone.utc) - timedelta(days=60))  # too old
    _run(conn, ws, 7000, status="error")  # not ok
    rows = conn.execute("SELECT duration_ms, p90_ms FROM qlens.v_slow_queries WHERE workspace_id=%s ORDER BY 1",
                        (ws,)).fetchall()
    assert [float(r["duration_ms"]) for r in rows] == [100.0]
    assert float(rows[0]["p90_ms"]) == pytest.approx(91.0)


def test_workspace_summary_stage_empty(conn):
    ws = _workspace(conn)
    row = conn.execute("SELECT * FROM qlens.v_workspace_summary WHERE workspace_id=%s", (ws,)).fetchone()
    assert row["stage"] == "empty" and row["query_count"] == 0
    assert row["row_count"] is None and row["column_count"] is None and row["table_count"] is None
    assert row["last_activity_at"] is not None


def test_workspace_summary_dataset_without_applied_proposal(conn):
    ws = _workspace(conn)
    ds = _dataset(conn, ws, status="analyzed")
    _proposal(conn, ds, "draft")  # a draft's tables must not be counted
    row = conn.execute("SELECT * FROM qlens.v_workspace_summary WHERE workspace_id=%s", (ws,)).fetchone()
    assert (row["stage"], row["table_count"]) == ("analyzed", 0)


def test_workspace_summary_with_dataset(conn):
    ws = _workspace(conn)
    ds = _dataset(conn, ws, status="applied")
    prop = _proposal(conn, ds, "applied", lossless_ok=True)
    _proposed_table(conn, prop, 1, "a")
    _proposed_table(conn, prop, 2, "b")
    draft = _proposal(conn, ds, "draft")          # a draft next to the applied design is not counted
    _proposed_table(conn, draft, 1, "a")
    _run(conn, ws, 5)
    row = conn.execute("SELECT * FROM qlens.v_workspace_summary WHERE workspace_id=%s", (ws,)).fetchone()
    assert (row["stage"], row["row_count"], row["column_count"]) == ("applied", 50, 4)
    assert (row["table_count"], row["query_count"]) == (2, 1)


def test_delete_user_cascades(conn):
    uid = _user(conn)
    ws = _workspace(conn, uid)
    ds = _dataset(conn, ws)
    _column(conn, ds)
    _run(conn, ws, 1)
    conn.execute("DELETE FROM qlens.users WHERE id=%s", (uid,))
    for table in ("workspaces", "datasets", "dataset_columns", "query_runs"):
        assert conn.execute(f"SELECT count(*) AS n FROM qlens.{table}").fetchone()["n"] == 0


def test_identifier_columns_are_checked(conn):
    ds = _dataset(conn)
    _expect(conn, errors.CheckViolation,
            "INSERT INTO qlens.dataset_columns (dataset_id, ordinal, name, label, inferred_type) "
            "VALUES (%s, 1, 'Bad Name', 'x', 'text')", (ds,))


def test_failed_run_needs_message(conn):
    ws = _workspace(conn)
    _expect(conn, errors.CheckViolation,
            "INSERT INTO qlens.query_runs (workspace_id, sql_text, source, target, status, duration_ms) "
            "VALUES (%s, 'x', 'typed', 'main', 'error', 1)", (ws,))
