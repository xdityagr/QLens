"""Typed INSERT, UPDATE and DELETE from the Data page's SQL tab: which table it may target, and its errors.

The statement itself runs in the sandbox (query.sandbox.run_write) as the workspace role. This module gives the
reasons in words: why a target is refused, and what a constraint error means, in the same plain English as the
Browse tab's own edits (service._explain).
"""
import re

from typing import Any

import psycopg
from psycopg import sql

from qlens import db
from qlens.data.service import Op, Table, _constraint, _explain, _singular, tables
from qlens.design.proposal import VIEW_NAME
from qlens.errors import ApiError


def writable_table(conn: psycopg.Connection, ws_id: int, schema: str | None, name: str,
                   position: int | None = None) -> Table:
    """The applied table a typed statement targets, or a 422 that says why it may not.

    The workspace role's privileges enforce the same thing; this gives the reason first, in words.
    """
    main = db.ws_schema(ws_id, "main")
    all_ = tables(conn, ws_id)

    def refuse(message: str) -> ApiError:
        return ApiError(422, "write_target_not_allowed", message, detail={"position": position, "table": name})

    if schema is not None and schema != main:
        raise refuse(f"Only the tables of your design can be changed here; {schema}.{name} is not one of them.")
    if name in all_:
        return all_[name]
    if name in ("_raw", "_staging"):
        raise refuse(f"{name} is the imported sheet and stays as it was imported. Change the generated tables "
                     "instead.")
    if name == VIEW_NAME:
        raise refuse(f"{name} is a view that rebuilds the sheet from your tables; change those tables instead.")
    raise refuse(f"There is no table called {name} in your design.")


# PostgreSQL's DETAIL line for key errors: 'Key (student_id)=(99999) is not present in table "students".'
_KEY_DETAIL = re.compile(
    r"^Key \((?P<cols>.*?)\)=\((?P<vals>.*)\) (?:already exists|is not present|is (?:still )?referenced)")


def key_values(detail: str | None) -> dict[str, str | None]:
    """The key a key error names, as {column: value}; {} when the line has another shape."""
    m = _KEY_DETAIL.match(detail or "")
    if not m:
        return {}
    cols, vals = m["cols"].split(", "), m["vals"].split(", ")
    # A value with ", " inside would split wrongly; then the key is not used rather than guessed.
    return dict(zip(cols, vals)) if len(cols) == len(vals) else {}


def explain_error(conn: psycopg.Connection, ws_id: int, t: Table, op: Op, e: psycopg.Error,
                  position: int | None = None) -> ApiError:
    """The Browse tab's constraint error for a typed statement.

    A typed statement has no submitted values or row id; the key PostgreSQL reports stands in for both.
    """
    values = key_values(e.diag.message_detail)
    state = e.diag.sqlstate or ""
    if state in ("23503", "23001") and "referenced from table" in (e.diag.message_detail or ""):
        err = _still_referenced(conn, t, op, values, e)
    elif state == "23503" and not values:
        err = _explain(conn, t, tables(conn, ws_id), op, None, values, e)
        ref = (err.detail or {}).get("referenced_table")
        err.message = (f"No such {_singular(ref)}: {ref} has no matching row." if ref
                       else "The referenced row does not exist.")
    else:
        err = _explain(conn, t, tables(conn, ws_id), op, None, values, e)
    if isinstance(err.detail, dict):
        err.detail["position"] = position   # where the editor can underline it, when PostgreSQL says
    return err


def _still_referenced(conn: psycopg.Connection, t: Table, op: Op, values: dict[str, str | None],
                      e: psycopg.Error) -> ApiError:
    """A DELETE, or an UPDATE of a key, on a row that other rows still point at.

    Counted by the key PostgreSQL names (usually id, but a foreign key can point at any unique column).
    """
    k = _constraint(conn, t.schema, e.diag.constraint_name)
    server = e.diag.message_primary or str(e)
    detail: dict[str, Any] = {
        "sqlstate": e.diag.sqlstate, "constraint": k["name"] if k else e.diag.constraint_name,
        "columns": list(k["columns"]) if k else [], "table": t.name, "operation": op, "kind": "foreign_key",
        "definition": k["definition"] if k else None, "server_message": server}
    noun = _singular(t.name)
    if k is None or len(values) != 1:
        return ApiError(409, "foreign_key_violation",
                        f"Other rows still point at this {noun}; delete or reassign them first.", detail=detail)
    child, child_cols = k["table"], list(k["columns"])
    [value] = values.values()
    # compared as text: the value comes from the DETAIL line, and the key can be of any type
    n = conn.execute(sql.SQL("SELECT count(*) AS n FROM {} WHERE {}::text = %s").format(
        sql.Identifier(t.schema, child), sql.Identifier(child_cols[0])), (value,)).fetchone()["n"]
    rows = "record" if n == 1 else "records"
    [key] = values.keys()
    middle = f", so its {key} cannot change" if op == "UPDATE" else ""
    message = (f"This {noun} is referenced by {n} {_singular(child)} {rows}{middle}; "
               "delete or reassign them first.")
    return ApiError(409, "foreign_key_violation", message,
                    detail={**detail, "referencing_table": child, "referencing_rows": n})
