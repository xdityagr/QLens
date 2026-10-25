import pytest

from qlens.errors import ApiError
from qlens.query.validate import validate_select


def test_trailing_semicolon_and_comments():
    assert validate_select("SELECT 1; -- hi\n") == "SELECT 1"
    assert validate_select("  SELECT 'a;b' /* c */ ;; ") == "SELECT 'a;b'"
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
