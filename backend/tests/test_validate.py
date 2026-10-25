import subprocess
import sys
import textwrap

import pytest

from qlens.errors import ApiError
from qlens.query.validate import validate_select, validate_write


def test_trailing_semicolon_and_comments():
    assert validate_select("SELECT 1; -- hi\n") == "SELECT 1"
    assert validate_select("  SELECT 'a;b' /* c */ ;; ") == "  SELECT 'a;b'"  # only the tail is trimmed
    assert validate_select("-- lead\nSELECT 1") == "-- lead\nSELECT 1"


@pytest.mark.parametrize("sql", [
    "SELECT 1 UNION SELECT 2",
    "WITH x AS (SELECT 1 AS a) SELECT * FROM x",
    "VALUES (1), (2)",
    "TABLE pg_class",
    "SELECT pg_sleep(0.01)",
    "SELECT * FROM (SELECT 1) s WHERE 'x' LIKE '%x'",
])
def test_accepts_selects(sql):
    assert validate_select(sql) == sql


@pytest.mark.parametrize("sql,code", [
    ("SELECT 1; SELECT 2", "multiple_statements"),
    ("DELETE FROM t", "not_a_select"),
    ("INSERT INTO t VALUES (1)", "not_a_select"),
    ("EXPLAIN SELECT 1", "not_a_select"),
    ("", "not_a_select"),
    ("-- nothing here\n", "not_a_select"),
    ("SELECT set_config('role','qlens_app',false)", "forbidden_function"),
    ("SELECT pg_catalog.set_config('role','x',false)", "forbidden_function"),
    ('SELECT "pg_terminate_backend"(1)', "forbidden_function"),
    ("SELECT * FROM pg_sleep_for('1s')", "forbidden_function"),
    ("SELECT * FROM t WHERE x IN (SELECT dblink('a','b'))", "forbidden_function"),
    ("SELECT lo_import('/etc/passwd')", "forbidden_function"),
    ("SELECT query_to_xml('select 1', true, true, '')", "forbidden_function"),
    ("SELECT query_to_xml_and_xmlschema('select 1', true, true, '')", "forbidden_function"),
    ("SELECT cursor_to_xml('c', 1, true, true, '')", "forbidden_function"),
    ("SELECT * FROM ts_stat('select 1')", "forbidden_function"),
    ("SELECT ts_rewrite('a'::tsquery, 'select 1')", "forbidden_function"),
    ("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", "not_a_select"),
    ("WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x", "not_a_select"),
    ("WITH x AS (UPDATE t SET a = 1 RETURNING *) SELECT * FROM x", "not_a_select"),
    ("SELECT * FROM (WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x) s", "not_a_select"),
    ("SELECT * INTO t2 FROM t", "not_a_select"),
    ("SELECT * FROM t FOR UPDATE", "not_a_select"),
    ("SELEC 1", "syntax_error"),
    ("SELECT 'unterminated", "syntax_error"),
])
def test_rejections(sql, code):
    with pytest.raises(ApiError) as e:
        validate_select(sql)
    assert e.value.status == 422 and e.value.code == code
    assert "position" in (e.value.detail or {})


def test_syntax_error_position_is_one_based():
    with pytest.raises(ApiError) as e:
        validate_select("SELEC 1")
    assert e.value.detail == {"position": 1}


def test_positions_count_characters_not_bytes():
    # 'é€' is 5 bytes but 2 characters; PostgreSQL positions are 1-based characters.
    with pytest.raises(ApiError) as e:
        validate_select("SELECT 'é€', pg_catalog.set_config('a','b',false)")
    assert e.value.code == "forbidden_function" and e.value.detail == {"position": 14}
    with pytest.raises(ApiError) as e:
        validate_select("SELECT 'é€' FROM FROM")
    assert e.value.code == "syntax_error" and e.value.detail == {"position": 18}
    with pytest.raises(ApiError) as e:
        validate_select("SELECT 'é€'; SELECT 2")
    assert e.value.code == "multiple_statements" and e.value.detail == {"position": 14}


def _plus_chain(n: int) -> str:
    return "SELECT " + "+".join(["1"] * n)


def test_moderately_long_expressions_are_fine():
    sql = _plus_chain(100)
    assert validate_select(sql) == sql
    big_in = "SELECT 1 WHERE 1 IN (" + ",".join(str(i) for i in range(1000)) + ")"
    assert validate_select(big_in) == big_in


@pytest.mark.parametrize("sql", [
    _plus_chain(2000),                              # deeper than the JSON decoder allows
    _plus_chain(6000),                              # crashed the process with pglast's tree builder
    "SELECT " + "abs(" * 2000 + "1" + ")" * 2000,
    "SELECT " + "NOT " * 5000 + "true",
    "SELECT 1 WHERE 1 IN (" + ",".join(["1"] * 5000) + ")",  # token cap
], ids=["plus2000", "plus6000", "nested_calls", "not_chain", "token_cap"])
def test_overly_complex_queries_are_rejected(sql):
    with pytest.raises(ApiError) as e:
        validate_select(sql)
    assert e.value.status == 422 and e.value.code == "query_too_complex"


def test_walk_is_iterative_for_deep_but_decodable_trees():
    # ~300 nested terms decode fine; the walk must not recurse per level.
    sql = _plus_chain(300) + " + pg_sleep(0)"
    assert validate_select(sql) == sql
    with pytest.raises(ApiError) as e:
        validate_select(_plus_chain(300) + " + length(set_config('a','b',false))")
    assert e.value.code == "forbidden_function"


def test_pathological_query_cannot_kill_the_process():
    # In a subprocess: if a regression reintroduces the C stack overflow, only the child dies.
    code = textwrap.dedent("""
        from qlens.query.validate import validate_select
        from qlens.errors import ApiError
        for n in (6000, 10000):
            try:
                validate_select("SELECT " + "+".join(["1"] * n))
            except ApiError as e:
                assert e.code == "query_too_complex", e.code
            else:
                raise SystemExit("accepted")
        print("survived")
    """)
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0 and r.stdout.strip() == "survived", (r.returncode, r.stdout, r.stderr[-300:])


# ---- validate_write: one INSERT, UPDATE or DELETE --------------------------------------------------

@pytest.mark.parametrize("sql,kind,schema,table", [
    ("UPDATE t SET a = 1 WHERE id = 2; -- done", "UPDATE", None, "t"),
    ("INSERT INTO ws_3.t (a) VALUES (1) RETURNING id", "INSERT", "ws_3", "t"),
    ("DELETE FROM ONLY t USING u WHERE t.id = u.id", "DELETE", None, "t"),
    ("UPDATE t SET a = s.a FROM (SELECT 1 AS a) s", "UPDATE", None, "t"),
    ("WITH s AS (SELECT 1 AS a) INSERT INTO t (a) SELECT a FROM s", "INSERT", None, "t"),
    ("INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = excluded.a", "INSERT", None, "t"),
])
def test_write_accepted(sql, kind, schema, table):
    w = validate_write(sql)
    assert (w.kind, w.schema, w.table) == (kind, schema, table)
    assert w.sql == sql.split(";")[0]


@pytest.mark.parametrize("sql,code", [
    ("SELECT 1", "not_a_write"),
    ("TRUNCATE t", "not_a_write"),
    ("COPY t FROM STDIN", "not_a_write"),
    ("CREATE TABLE t2 (a int)", "not_a_write"),
    ("ALTER TABLE t ADD COLUMN b int", "not_a_write"),
    ("DROP TABLE t", "not_a_write"),
    ("GRANT ALL ON t TO PUBLIC", "not_a_write"),
    ("SET ROLE qlens_app", "not_a_write"),
    ("MERGE INTO t USING u ON t.id = u.id WHEN MATCHED THEN DELETE", "not_a_write"),
    ("", "not_a_select"),
    ("UPDATE t SET a = 1; DELETE FROM t", "multiple_statements"),
    ("WITH x AS (DELETE FROM u RETURNING id) UPDATE t SET a = 1 WHERE id IN (SELECT id FROM x)", "one_write_only"),
    ("INSERT INTO t SELECT * FROM (WITH x AS (UPDATE u SET a = 1 RETURNING *) SELECT * FROM x) s", "one_write_only"),
    ("UPDATE t SET a = (SELECT 1 FROM u INTO v)", "syntax_error"),
    ("UPDATE t SET a = set_config('role', 'qlens_app', false)", "forbidden_function"),
    ("DELETE FROM t WHERE pg_read_file('x') IS NOT NULL", "forbidden_function"),
    ("UPDATE qlens.qlens.t SET a = 1", "write_target_not_allowed"),
    ("INSERT INTO t (a) VALUES (lo_create(0))", "forbidden_function"),
    ("UPDATE t SET a = lo_from_bytea(0, 'x')", "forbidden_function"),
    ("UPDATE t SET a = lo_put(1, 0, 'x')", "forbidden_function"),
    ("DELETE FROM t WHERE lo_unlink(1) = 1", "forbidden_function"),
    ("UPDATE t SET a = 1 WHERE pg_notify('c', 'x') IS NULL", "forbidden_function"),
    ("UPDATE t SET", "syntax_error"),
])
def test_write_rejections(sql, code):
    with pytest.raises(ApiError) as e:
        validate_write(sql)
    assert e.value.status == 422 and e.value.code == code
