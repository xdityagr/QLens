"""Static checks on user SQL before it reaches the sandbox.

This is the friendly first layer: it gives specific error messages. It is not the security boundary.
The sandbox's own guarantees (a workspace role that can read only its own schemas and write only its
generated tables, a read-only transaction for SELECTs, statement timeout) hold even if a statement slips
past these checks.

The statement is parsed to JSON (parse_sql_json) and walked iteratively. pglast's Cython tree builder
recurses once per nesting level and overflows the C stack on a long `1+1+1+...` (a 12 KB query killed the
whole process), so it is deliberately not used on untrusted text. Python's json decoder refuses
deep nesting with RecursionError instead of crashing, and the token cap bounds the work.
"""

import json
from dataclasses import dataclass
from itertools import accumulate

from pglast import parser

from qlens.errors import ApiError

# pg_sleep stays allowed so the statement timeout can be demonstrated.
FORBIDDEN_FUNCTIONS = frozenset({
    "set_config", "pg_sleep_for", "pg_sleep_until", "pg_terminate_backend", "pg_cancel_backend",
    "pg_reload_conf", "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "lo_import", "lo_export",
    "dblink", "dblink_exec", "pg_advisory_lock", "pg_advisory_xact_lock",
    # Functions that run another query from a string: they would sidestep the checks done here.
    "query_to_xml", "query_to_xml_and_xmlschema", "query_to_xmlschema", "cursor_to_xml", "cursor_to_xmlschema",
    "ts_stat", "ts_rewrite",
})

_DATA_MODIFYING = frozenset({"InsertStmt", "UpdateStmt", "DeleteStmt", "MergeStmt"})
# Tokens that carry no meaning for the statement: trimmed from the end of what we hand to the sandbox.
_TRAILING_NOISE = {"ASCII_59", "SQL_COMMENT", "C_COMMENT"}
# A realistic lab query is a few hundred tokens; this only stops absurd inputs early.
MAX_TOKENS = 4000
_TOO_COMPLEX_PARSER_MESSAGES = ("stack depth limit exceeded", "memory exhausted")


def _reject(code: str, message: str, position: int | None = None) -> ApiError:
    return ApiError(422, code, message, detail={"position": position})


def _too_complex() -> ApiError:
    return _reject("query_too_complex", "This query is too large or too deeply nested to check. Simplify it.")


def _char_pos(sql_text: str, byte_offset: int | None) -> int | None:
    """1-based character position (the convention of PostgreSQL's own error positions).

    parse_sql_json reports UTF-8 byte offsets, so a query with non-ASCII text before the error needs converting.
    """
    if byte_offset is None or byte_offset < 0:
        return None
    return len(sql_text.encode()[:byte_offset].decode(errors="ignore")) + 1


def _parse_error_position(sql_text: str, reported: int) -> int:
    """0-based character index of a syntax error.

    pglast converts the parser's byte offset to a character offset twice, so after non-ASCII text the number it
    reports is too small. Undoing it: the true index is the byte length of the first `reported` characters.
    Identity for ASCII.
    """
    if reported <= 0 or sql_text.isascii():
        return reported
    ends = list(accumulate(len(ch.encode()) for ch in sql_text))
    return ends[min(reported, len(ends)) - 1]


def _strip_trailing(sql_text: str, tokens) -> str:
    end = 0
    for tok in tokens:
        if tok.name not in _TRAILING_NOISE:
            end = tok.end + 1
    return sql_text[:end].rstrip()


_NESTED_WRITE_IN_SELECT = ("not_a_select", "Data-modifying statements are not allowed, even inside a WITH.")


def _check(sql_text: str, root: dict, nested_write: tuple[str, str] = _NESTED_WRITE_IN_SELECT,
           forbidden: frozenset[str] = FORBIDDEN_FUNCTIONS) -> None:
    """Iterative walk over the parse tree (nested dicts and lists), so depth cannot exhaust the stack."""
    stack: list = [root]
    while stack:
        item = stack.pop()
        if isinstance(item, list):
            stack.extend(item)
            continue
        if not isinstance(item, dict):
            continue
        for key, val in item.items():
            if key == "SelectStmt":
                if val.get("intoClause") is not None:
                    raise _reject("not_a_select", "SELECT ... INTO creates a table; only plain SELECT is allowed.")
                if val.get("lockingClause"):
                    raise _reject("not_a_select", "Row-locking clauses (FOR UPDATE/SHARE) are not allowed.")
            elif key in _DATA_MODIFYING:
                raise _reject(*nested_write)
            elif key == "FuncCall":
                name = (val.get("funcname") or [{}])[-1].get("String", {}).get("sval")
                if name in forbidden:
                    raise _reject("forbidden_function", f"The function {name}() is not allowed.",
                                  _char_pos(sql_text, val.get("location")))
            if isinstance(val, (dict, list)):
                stack.append(val)


def _parse_one(sql_text: str, empty_message: str) -> tuple[list, dict]:
    """(tokens, statement) of exactly one statement, parsed to JSON; every refusal is a 422 with a position."""
    try:
        tokens = parser.scan(sql_text)  # lexical errors (unterminated quote) surface here
        if len(tokens) > MAX_TOKENS:
            raise _too_complex()
        tree = json.loads(parser.parse_sql_json(sql_text))
    except parser.ParseError as e:
        message = str(e.args[0])
        if message.startswith(_TOO_COMPLEX_PARSER_MESSAGES):
            raise _too_complex() from None
        index = e.args[1] if len(e.args) > 1 else None
        position = _parse_error_position(sql_text, index) + 1 if isinstance(index, int) else None
        raise _reject("syntax_error", message, position) from None
    except RecursionError:
        raise _too_complex() from None
    stmts = tree.get("stmts") or []
    if not stmts:
        raise _reject("not_a_select", empty_message)
    if len(stmts) > 1:
        raise _reject("multiple_statements", "Run one statement at a time.",
                      _char_pos(sql_text, stmts[1].get("stmt_location")))
    return tokens, stmts[0]["stmt"]


def validate_select(sql_text: str) -> str:
    tokens, root = _parse_one(sql_text, "Type a SELECT query to run.")
    if "SelectStmt" not in root:
        raise _reject("not_a_select", "Only SELECT queries can be run here.")
    try:
        _check(sql_text, root)
    except RecursionError:  # pragma: no cover - the walk is iterative; kept as a backstop
        raise _too_complex() from None
    return _strip_trailing(sql_text, tokens)


# On the write path also: large objects and NOTIFY have effects outside the target table.
WRITE_FORBIDDEN_FUNCTIONS = FORBIDDEN_FUNCTIONS | {"lo_create", "lo_from_bytea", "lo_put", "lo_unlink", "pg_notify"}

_WRITE_KINDS = {"InsertStmt": "INSERT", "UpdateStmt": "UPDATE", "DeleteStmt": "DELETE"}
_NAMED_STATEMENTS = {"TruncateStmt": "TRUNCATE", "CopyStmt": "COPY", "MergeStmt": "MERGE"}


@dataclass(frozen=True)
class WriteStatement:
    sql: str                # trimmed of trailing semicolons and comments
    kind: str               # INSERT, UPDATE or DELETE
    schema: str | None      # as written; None when unqualified
    table: str
    position: int | None    # of the table name, 1-based


def validate_write(sql_text: str) -> WriteStatement:
    """One INSERT, UPDATE or DELETE, and nothing else that changes data.

    Which tables it may target is the caller's check (it knows the workspace); the privileges of the workspace
    role are the real boundary: it can write only the generated tables, never the sheet copies or the lab.
    """
    tokens, root = _parse_one(sql_text, "Type an INSERT, UPDATE or DELETE to run.")
    stmt_kind = next(iter(root), "")
    if stmt_kind == "SelectStmt":
        raise _reject("not_a_write", "This is a SELECT, which only reads; run it with Run.")
    if stmt_kind not in _WRITE_KINDS:
        what = _NAMED_STATEMENTS.get(stmt_kind, "Changing the tables themselves")
        raise _reject("not_a_write", f"Only INSERT, UPDATE or DELETE can run here; {what} is not allowed.")
    body = root[stmt_kind]
    try:
        # Walk the statement's parts, not the statement itself: any other INSERT/UPDATE/DELETE inside is refused.
        _check(sql_text, body, ("one_write_only",
                                "Only one INSERT, UPDATE or DELETE at a time; a WITH cannot change data too."),
               WRITE_FORBIDDEN_FUNCTIONS)
    except RecursionError:  # pragma: no cover - the walk is iterative; kept as a backstop
        raise _too_complex() from None
    rel = body["relation"]
    if rel.get("catalogname"):
        raise _reject("write_target_not_allowed", "Name the table without a database name.",
                      _char_pos(sql_text, rel.get("location")))
    return WriteStatement(_strip_trailing(sql_text, tokens), _WRITE_KINDS[stmt_kind], rel.get("schemaname"),
                          rel["relname"], _char_pos(sql_text, rel.get("location")))
