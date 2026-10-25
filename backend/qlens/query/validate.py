"""Static checks on user SQL before it reaches the sandbox.

This is the friendly first layer: it gives specific error messages. It is not the security boundary.
The sandbox's own guarantees (workspace role with SELECT-only grants, read-only transaction,
statement timeout) hold even if a statement slips past these checks.
"""

from typing import Any

from pglast import ast, parse_sql, parser

from qlens.errors import ApiError

# pg_sleep stays allowed so the statement timeout can be demonstrated.
FORBIDDEN_FUNCTIONS = frozenset({
    "set_config", "pg_sleep_for", "pg_sleep_until", "pg_terminate_backend", "pg_cancel_backend",
    "pg_reload_conf", "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "lo_import", "lo_export",
    "dblink", "dblink_exec", "pg_advisory_lock", "pg_advisory_xact_lock",
})

_DATA_MODIFYING = (ast.InsertStmt, ast.UpdateStmt, ast.DeleteStmt, ast.MergeStmt)
# Tokens that carry no meaning for the statement: trimmed from the end of what we hand to the sandbox.
_TRAILING_NOISE = {"ASCII_59", "SQL_COMMENT", "C_COMMENT"}


def _reject(code: str, message: str, position: int | None = None) -> ApiError:
    return ApiError(422, code, message, detail={"position": position})


def _walk(node: Any):
    if isinstance(node, ast.Node):
        yield node
        for slot in node.__slots__:
            yield from _walk(getattr(node, slot))
    elif isinstance(node, (tuple, list)):
        for item in node:
            yield from _walk(item)


def _char_pos(sql_text: str, byte_offset: int) -> int | None:
    """1-based character position (the convention of PostgreSQL's own error positions)."""
    if byte_offset is None or byte_offset < 0:
        return None
    return len(sql_text.encode()[:byte_offset].decode(errors="ignore")) + 1


def _strip_trailing(sql_text: str) -> str:
    end = 0
    for tok in parser.scan(sql_text):
        if tok.name not in _TRAILING_NOISE:
            end = tok.end + 1
    return sql_text[:end].strip()


def validate_select(sql_text: str) -> str:
    try:
        stmts = parse_sql(sql_text)
    except parser.ParseError as e:
        index = e.args[1] if len(e.args) > 1 else None
        raise _reject("syntax_error", str(e.args[0]), index + 1 if isinstance(index, int) else None) from None
    if not stmts:
        raise _reject("not_a_select", "Type a SELECT query to run.")
    if len(stmts) > 1:
        raise _reject("multiple_statements", "Run one statement at a time.",
                      _char_pos(sql_text, stmts[1].stmt_location))
    root = stmts[0].stmt
    if not isinstance(root, ast.SelectStmt):
        raise _reject("not_a_select", "Only SELECT queries can be run here.")

    for node in _walk(root):
        if isinstance(node, ast.SelectStmt):
            if node.intoClause is not None:
                raise _reject("not_a_select", "SELECT ... INTO creates a table; only plain SELECT is allowed.")
            if node.lockingClause:
                raise _reject("not_a_select", "Row-locking clauses (FOR UPDATE/SHARE) are not allowed.")
        elif isinstance(node, _DATA_MODIFYING):
            raise _reject("not_a_select", "Data-modifying statements are not allowed, even inside a WITH.")
        elif isinstance(node, ast.FuncCall):
            name = node.funcname[-1].sval
            if name in FORBIDDEN_FUNCTIONS:
                raise _reject("forbidden_function", f"The function {name}() is not allowed.",
                              _char_pos(sql_text, node.location))
    return _strip_trailing(sql_text)
