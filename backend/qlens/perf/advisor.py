"""Index suggestions read off an executed plan.

Two patterns are recognised:
  * a Seq Scan whose Filter keeps few of the rows it reads: index the columns the filter compares,
  * a Hash Join that reads every row of a big seq-scanned side to keep few: index that side's join column.

The Filter / Hash Cond text comes from EXPLAIN and so carries the user's literals. It is parsed with
parse_sql_json and walked iteratively, like the validator does, never with pglast's recursive tree builder.
"""
import json
from typing import Literal

import psycopg
from pglast import parser
from pydantic import BaseModel

from qlens import db
from qlens.design.naming import MAX_IDENT
from qlens.perf.explain import PlanOut, walk

MAX_COLUMNS = 3
# An index rarely beats reading the whole table when the query keeps more than about a fifth of it.
SELECTIVE = 0.2
_SEQ_SCANS = {"Seq Scan", "Parallel Seq Scan"}
_EQUALITY = {"="}
_RANGE = {"<", ">", "<=", ">="}
_LIKE = "~~"   # how EXPLAIN prints LIKE; the databases use the C collation, so a plain btree serves 'prefix%'


class IndexSuggestion(BaseModel):
    table: str
    columns: list[str]
    reason: str
    ddl: str


# ---- names and DDL (shared with lab.try_index) ----------------------------------------------------

def index_name(table: str, columns: list[str], suffix: int = 1) -> str:
    """ix_<table>_<cols>, at most 63 characters; a numeric suffix tells apart names that truncate alike."""
    tail = f"_{suffix}" if suffix > 1 else ""
    return f"ix_{table}_{'_'.join(columns)}"[:MAX_IDENT - len(tail)] + tail


def index_ddl(conn: psycopg.Connection, ws_id: int, name: str, table: str, columns: list[str]) -> str:
    """The CREATE INDEX statement as a person would write it: identifiers quoted only where needed."""
    schema = db.ws_schema(ws_id, "lab")
    rows = conn.execute("SELECT n, quote_ident(n) AS q FROM unnest(%s::text[]) AS n",
                        ([schema, name, table, *columns],)).fetchall()
    q = {r["n"]: r["q"] for r in rows}
    return f"CREATE INDEX {q[name]} ON {q[schema]}.{q[table]} ({', '.join(q[c] for c in columns)})"


def index_columns(conn: psycopg.Connection, schema: str, table: str) -> list[list[str]]:
    """Key columns (in index order) of every index on schema.table; expression keys come back as NULL."""
    rows = conn.execute(
        """SELECT ARRAY(SELECT a.attname
                        FROM generate_series(1, i.indnkeyatts) AS k
                        LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[k - 1]
                        ORDER BY k) AS columns
           FROM pg_index i
           WHERE i.indrelid = to_regclass(format('%%I.%%I', %s::text, %s::text))""", (schema, table)).fetchall()
    return [r["columns"] for r in rows]


def covered(existing: list[list[str]], columns: list[str]) -> bool:
    """Some index already starts with exactly these columns."""
    return any(cols[:len(columns)] == columns for cols in existing)


# ---- reading the plan -----------------------------------------------------------------------------

def _parse_condition(text: str) -> dict | None:
    try:
        tree = json.loads(parser.parse_sql_json(f"SELECT 1 FROM t WHERE {text}"))
    except (parser.ParseError, RecursionError):
        return None  # e.g. "(hashed SubPlan 1)": nothing an index on a column would serve
    return tree["stmts"][0]["stmt"]["SelectStmt"].get("whereClause")


def _conjuncts(expr: dict) -> list[dict]:
    """The AND-ed parts of a condition. Branches of an OR are left out: one index cannot serve them all."""
    out, stack = [], [expr]
    while stack:
        e = stack.pop()
        b = e.get("BoolExpr")
        if b is not None and b.get("boolop") == "AND_EXPR":
            stack.extend(reversed(b.get("args") or []))
        else:
            out.append(e)
    return out


def _column(e: dict, names: set[str]) -> str | None:
    """The column a ColumnRef names, if it is unqualified or qualified by one of `names` (alias or table)."""
    ref = e.get("ColumnRef") if isinstance(e, dict) else None
    if ref is None:
        return None
    fields = [f.get("String", {}).get("sval") for f in ref.get("fields") or []]
    if len(fields) == 1 or (len(fields) == 2 and fields[0] in names):
        return fields[-1]
    return None


def _like_prefix(e: dict | None) -> bool:
    """A pattern constant that starts with a fixed prefix ('abc%'), the only LIKE a btree can serve."""
    while isinstance(e, dict) and "TypeCast" in e:
        e = e["TypeCast"].get("arg")
    sval = (e or {}).get("A_Const", {}).get("sval", {}).get("sval") if isinstance(e, dict) else None
    return bool(sval) and sval[0] not in "%_"


def _filter_columns(text: str, names: set[str]) -> list[str]:
    """Columns of the scanned relation the filter compares in a way a btree index can serve; equality first."""
    where = _parse_condition(text)
    if where is None:
        return []
    equal, ranged = [], []
    for part in _conjuncts(where):
        a = part.get("A_Expr")
        if a is None:
            continue
        op = (a.get("name") or [{}])[-1].get("String", {}).get("sval")
        kind, left, right = a.get("kind"), a.get("lexpr"), a.get("rexpr")
        lcol, rcol = _column(left, names), _column(right, names)
        if (lcol is None) == (rcol is None):
            continue  # no column of this relation, or columns on both sides
        col = lcol or rcol
        if kind == "AEXPR_OP" and op in _EQUALITY or kind == "AEXPR_IN" or (kind == "AEXPR_OP_ANY" and op == "="):
            equal.append(col)
        elif kind == "AEXPR_OP" and op in _RANGE or kind == "AEXPR_BETWEEN":
            ranged.append(col)
        elif kind == "AEXPR_OP" and op == _LIKE and lcol is not None and _like_prefix(right):
            ranged.append(col)
    return list(dict.fromkeys(equal + ranged))[:MAX_COLUMNS]


def _scan_below(node: dict) -> dict:
    """The scan feeding a join input: the Hash node's child for the inner side."""
    while node.get("Node Type") == "Hash" and node.get("Plans"):
        node = node["Plans"][0]
    return node


def _rows(node: dict) -> float:
    return float(node.get("Actual Rows") or 0) * int(node.get("Actual Loops") or 0)


def _read(node: dict) -> float:
    """Rows a scan read: those it returned plus those its filter threw away."""
    return _rows(node) + float(node.get("Rows Removed by Filter") or 0) * int(node.get("Actual Loops") or 0)


def _names(node: dict) -> set[str]:
    return {n for n in (node.get("Alias"), node.get("Relation Name")) if n}


def suggest(conn: psycopg.Connection, ws_id: int, plan: PlanOut,
            target: Literal["main", "lab"]) -> list[IndexSuggestion]:
    schema = db.ws_schema(ws_id, target)
    tables = {r["relname"] for r in conn.execute(
        "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace "
        "WHERE n.nspname = %s AND c.relkind IN ('r', 'p')", (schema,))}
    found: list[tuple[str, list[str], str]] = []

    for node, _, _ in walk(plan.plan):
        kind = node.get("Node Type")
        if kind in _SEQ_SCANS and node.get("Filter") and node.get("Relation Name") in tables:
            kept, read = _rows(node), _read(node)
            columns = _filter_columns(node["Filter"], _names(node))
            if columns and read > 0 and kept <= SELECTIVE * read:
                found.append((node["Relation Name"], columns,
                              f"Seq Scan read {round(read):,} rows of {node['Relation Name']} to keep "
                              f"{round(kept):,} — an index on ({', '.join(columns)}) lets Postgres jump "
                              f"straight to them."))
        elif kind == "Hash Join" and node.get("Hash Cond") and len(node.get("Plans") or []) == 2:
            outer, inner = (_scan_below(p) for p in node["Plans"])
            big = outer if _rows(outer) >= _rows(inner) else inner
            joined = _rows(node)
            if (big.get("Node Type") not in _SEQ_SCANS or big.get("Relation Name") not in tables
                    or _read(big) == 0 or joined > SELECTIVE * _read(big)):
                continue
            columns = _filter_columns(node["Hash Cond"], _names(big))
            if columns:
                found.append((big["Relation Name"], columns,
                              f"Hash Join read all {round(_read(big)):,} rows of {big['Relation Name']} to match "
                              f"{round(joined):,} — an index on ({', '.join(columns)}) lets Postgres look up "
                              f"just the matching rows."))

    out: list[IndexSuggestion] = []
    existing: dict[str, list[list[str]]] = {}
    for table, columns, reason in found:
        if any(s.table == table and s.columns == columns for s in out):
            continue
        if table not in existing:
            existing[table] = index_columns(conn, schema, table)
        if covered(existing[table], columns):
            continue
        out.append(IndexSuggestion(table=table, columns=columns, reason=reason,
                                   ddl=index_ddl(conn, ws_id, index_name(table, columns), table, columns)))
    return out
