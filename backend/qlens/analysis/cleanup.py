"""Near-duplicate values, inconsistencies (approximate FDs) and the fixes that clean _staging.

Every edit here goes to `_staging` only and is logged in qlens.dataset_fixes; `_raw` is never touched.
After an edit the affected columns are re-profiled, because key and FD discovery prune by those counts.
"""
import json
from datetime import datetime
from typing import TYPE_CHECKING, Any

import psycopg
from psycopg import sql
from pydantic import BaseModel

from qlens import db
from qlens.errors import ApiError
from qlens.ingest.stage import refresh_column_profile

if TYPE_CHECKING:
    from qlens.analysis.discover import AnalysisOut

MAX_DISTINCT = 5000          # the self-join below is quadratic in distinct values
SIMILARITY_THRESHOLD = 0.6

# Spellings that differ only in case, spacing or full stops ("Mrs. Rao" / "Mrs Rao") are certain duplicates.
_NORMALIZED = r"lower(regexp_replace(btrim({}), '[\s.]+', ' ', 'g'))"

_PG_TYPE = {"integer": "bigint", "numeric": "numeric", "boolean": "boolean", "date": "date", "text": "text"}


class DuplicateValueOut(BaseModel):
    value: str
    rows: int


class DuplicateGroupOut(BaseModel):
    id: int
    column: str
    canonical_value: str
    confidence: str
    max_similarity: float | None
    status: str
    values: list[DuplicateValueOut]


class VariantOut(BaseModel):
    value: str | None
    rows: int


class ConflictOut(BaseModel):
    lhs_values: list[str | None]
    variants: list[VariantOut]
    suggested: str | None


class InconsistencyOut(BaseModel):
    fd_id: int
    sentence: str
    lhs: list[str]
    rhs: str
    conflicts: list[ConflictOut]


class FixOut(BaseModel):
    id: int
    kind: str
    column: str
    from_value: str | None
    to_value: str | None
    rows_affected: int
    created_at: datetime


def _dataset(conn: psycopg.Connection, dataset_id: int) -> dict:
    ds = conn.execute("SELECT id, workspace_id FROM qlens.datasets WHERE id = %s", (dataset_id,)).fetchone()
    if ds is None:
        raise ApiError(404, "no_dataset", "This workspace has no dataset yet.")
    return ds


def _staging(ws_id: int) -> sql.Composed:
    return sql.SQL("{}.{}").format(sql.Identifier(db.ws_schema(ws_id, "src")), sql.Identifier("_staging"))


def _log_fix(conn: psycopg.Connection, dataset_id: int, kind: str, column_id: int,
             from_value: str | None, to_value: str | None, rows: int) -> None:
    conn.execute("INSERT INTO qlens.dataset_fixes (dataset_id, kind, column_id, from_value, to_value, rows_affected) "
                 "VALUES (%s, %s, %s, %s, %s, %s)", (dataset_id, kind, column_id, from_value, to_value, rows))


# ---- near-duplicate detection ---------------------------------------------------------------------

class _Clusters:
    """Union-find over values."""

    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a: str, b: str) -> None:
        self.parent[self.find(a)] = self.find(b)


def _canonical(members: dict[str, int]) -> str:
    return min(members, key=lambda v: (-members[v], v))        # most frequent, then smallest text


def _column_clusters(conn: psycopg.Connection, ws_id: int, name: str) -> list[tuple[str, float, dict[str, int]]]:
    """(confidence, max_similarity, {value: rows}) for each cluster of two or more spellings."""
    col = sql.Identifier(name)
    # v: each distinct value with its row count and its normalized form; cls: spellings sharing that form.
    values = sql.SQL(
        "WITH v AS (SELECT {c}::text AS val, count(*)::int AS n, " + _NORMALIZED.format("{c}") + " AS norm "
        "           FROM {t} WHERE {c} IS NOT NULL AND btrim({c}) <> '' GROUP BY {c}), "
        "     c AS (SELECT *, count(*) OVER (PARTITION BY norm) AS cls FROM v) ").format(c=col, t=_staging(ws_id))
    out: list[tuple[str, float, dict[str, int]]] = []

    # Certain duplicates: spellings with equal normalized form form one group per form.
    same = conn.execute(values + sql.SQL(
        "SELECT a.norm, a.val AS a, a.n AS an, b.val AS b, b.n AS bn, similarity(a.val, b.val) AS sim "
        "FROM c a JOIN c b ON a.norm = b.norm AND a.val < b.val")).fetchall()
    by_norm: dict[str, dict[str, int]] = {}
    best: dict[str, float] = {}
    for r in same:
        members = by_norm.setdefault(r["norm"], {})
        members[r["a"]], members[r["b"]] = r["an"], r["bn"]
        best[r["norm"]] = max(best.get(r["norm"], 0.0), r["sim"])
    out += [("same_normalized", best[norm], members) for norm, members in by_norm.items()]

    # Probable duplicates (typos) are only sought among values that have no certain duplicate: a spelling
    # already explained as a variant must not also appear in a second group. Two values whose digits differ
    # are different things, not misspellings ("Foundation 9" / "Foundation 10", bill KB-0001 / KB-0008,
    # two phone numbers), although they share most trigrams.
    clusters, counts, sims = _Clusters(), {}, {}
    pairs = conn.execute(values + sql.SQL(
        "SELECT a.val AS a, a.n AS an, b.val AS b, b.n AS bn, similarity(a.val, b.val) AS sim "
        "FROM c a JOIN c b ON a.val < b.val AND a.cls = 1 AND b.cls = 1 "
        "WHERE regexp_replace(a.val, '[^0-9]', '', 'g') = regexp_replace(b.val, '[^0-9]', '', 'g') "
        "AND similarity(a.val, b.val) >= %s"),
        (SIMILARITY_THRESHOLD,)).fetchall()
    for r in pairs:
        counts[r["a"]], counts[r["b"]] = r["an"], r["bn"]
        clusters.union(r["a"], r["b"])
    for r in pairs:
        root = clusters.find(r["a"])
        sims[root] = max(sims.get(root, 0.0), r["sim"])
    grouped: dict[str, dict[str, int]] = {}
    for v, n in counts.items():
        grouped.setdefault(clusters.find(v), {})[v] = n
    out += [("similar", sims[root], members) for root, members in grouped.items()]
    return out


def find_duplicates(conn: psycopg.Connection, dataset_id: int) -> None:
    """Replace the dataset's pending duplicate groups; merged and dismissed ones are history and stay."""
    ds = _dataset(conn, dataset_id)
    conn.execute("DELETE FROM qlens.duplicate_groups WHERE dataset_id = %s AND status = 'pending'", (dataset_id,))
    cols = conn.execute(
        "SELECT id, name FROM qlens.dataset_columns WHERE dataset_id = %s AND inferred_type = 'text' "
        "AND distinct_count BETWEEN 2 AND %s ORDER BY ordinal", (dataset_id, MAX_DISTINCT)).fetchall()
    for col in cols:
        old = conn.execute(
            "SELECT g.id, g.canonical_value, g.status, array_agg(v.value) AS vals FROM qlens.duplicate_groups g "
            "JOIN qlens.duplicate_values v ON v.group_id = g.id WHERE g.dataset_id = %s AND g.column_id = %s "
            "GROUP BY g.id", (dataset_id, col["id"])).fetchall()
        dismissed = [set(g["vals"]) for g in old if g["status"] == "dismissed"]
        for confidence, similarity, members in _column_clusters(conn, ds["workspace_id"], col["name"]):
            if any(set(members) <= d for d in dismissed):
                continue                                    # the user already said these are different
            canonical = _canonical(members)
            # One group per canonical spelling (UNIQUE): a finished group of the same name is superseded.
            conn.execute("DELETE FROM qlens.duplicate_groups WHERE dataset_id = %s AND column_id = %s "
                         "AND canonical_value = %s", (dataset_id, col["id"], canonical))
            gid = conn.execute(
                "INSERT INTO qlens.duplicate_groups (dataset_id, column_id, canonical_value, confidence, "
                "max_similarity) VALUES (%s, %s, %s, %s, %s) RETURNING id",
                (dataset_id, col["id"], canonical, confidence, min(similarity, 1.0))).fetchone()["id"]
            for value, rows in members.items():
                conn.execute("INSERT INTO qlens.duplicate_values (group_id, value, row_count) VALUES (%s, %s, %s)",
                             (gid, value, rows))


def load_duplicates(conn: psycopg.Connection, dataset_id: int) -> list[DuplicateGroupOut]:
    groups = conn.execute(
        "SELECT g.id, c.name AS column, g.canonical_value, g.confidence, g.max_similarity, g.status "
        "FROM qlens.duplicate_groups g JOIN qlens.dataset_columns c ON c.id = g.column_id "
        "WHERE g.dataset_id = %s ORDER BY c.ordinal, g.canonical_value", (dataset_id,)).fetchall()
    values: dict[int, list[DuplicateValueOut]] = {}
    for v in conn.execute(
            "SELECT v.group_id, v.value, v.row_count FROM qlens.duplicate_values v "
            "JOIN qlens.duplicate_groups g ON g.id = v.group_id WHERE g.dataset_id = %s "
            "ORDER BY v.row_count DESC, v.value", (dataset_id,)):
        values.setdefault(v["group_id"], []).append(DuplicateValueOut(value=v["value"], rows=v["row_count"]))
    return [DuplicateGroupOut(**g, values=values.get(g["id"], [])) for g in groups]


# ---- merging and dismissing -----------------------------------------------------------------------

def _rewrite(conn: psycopg.Connection, ws_id: int, column: str, pg_type: str, where: sql.Composable,
             where_params: list[Any], new: str | None) -> dict[str | None, int]:
    """Set `column` to `new` on matching rows that differ; returns {old value: rows changed}."""
    c, t, ty = sql.Identifier(column), _staging(ws_id), sql.SQL(pg_type)
    rows = conn.execute(
        sql.SQL("WITH old AS (SELECT _row_id, {c} AS prev FROM {t} WHERE ({where}) "
                "                AND {c} IS DISTINCT FROM CAST(%s AS {ty}) FOR UPDATE), "
                "     upd AS (UPDATE {t} s SET {c} = CAST(%s AS {ty}) FROM old WHERE s._row_id = old._row_id "
                "             RETURNING old.prev::text AS prev) "
                "SELECT prev, count(*)::int AS n FROM upd GROUP BY prev").format(c=c, t=t, ty=ty, where=where),
        [*where_params, new, new]).fetchall()
    return {r["prev"]: r["n"] for r in rows}


def _group(conn: psycopg.Connection, dataset_id: int, group_id: int) -> dict:
    g = conn.execute(
        "SELECT g.id, g.column_id, c.name AS column, g.canonical_value, g.status FROM qlens.duplicate_groups g "
        "JOIN qlens.dataset_columns c ON c.id = g.column_id WHERE g.id = %s AND g.dataset_id = %s",
        (group_id, dataset_id)).fetchone()
    if g is None:
        raise ApiError(404, "group_not_found", "Duplicate group not found.")
    return g


def merge_group(conn: psycopg.Connection, dataset_id: int, group_id: int, canonical: str | None) -> int:
    """Rewrite every other spelling in the group to `canonical`; returns the number of rows changed."""
    ds = _dataset(conn, dataset_id)
    g = _group(conn, dataset_id, group_id)
    if g["status"] != "pending":
        raise ApiError(409, "group_not_pending", "This group has already been merged or dismissed.")
    values = [v["value"] for v in conn.execute(
        "SELECT value FROM qlens.duplicate_values WHERE group_id = %s ORDER BY value", (group_id,))]
    target = g["canonical_value"] if canonical is None else canonical
    if target not in values:
        raise ApiError(422, "bad_canonical", "The chosen spelling is not one of the values in this group.")
    with conn.transaction():
        changed = _rewrite(conn, ds["workspace_id"], g["column"], "text", sql.SQL("{} = ANY(%s)").format(
            sql.Identifier(g["column"])), [[v for v in values if v != target]], target)
        for old, rows in changed.items():
            _log_fix(conn, dataset_id, "merge", g["column_id"], old, target, rows)
        # A finished group of the same name (an earlier merge) would collide with the UNIQUE constraint.
        conn.execute("DELETE FROM qlens.duplicate_groups WHERE dataset_id = %s AND column_id = %s "
                     "AND canonical_value = %s AND id <> %s", (dataset_id, g["column_id"], target, group_id))
        conn.execute("UPDATE qlens.duplicate_groups SET status = 'merged', canonical_value = %s WHERE id = %s",
                     (target, group_id))
        refresh_column_profile(conn, ds["workspace_id"], dataset_id, [g["column"]])
    return sum(changed.values())


def dismiss_group(conn: psycopg.Connection, dataset_id: int, group_id: int) -> None:
    g = _group(conn, dataset_id, group_id)
    if g["status"] != "pending":
        raise ApiError(409, "group_not_pending", "This group has already been merged or dismissed.")
    conn.execute("UPDATE qlens.duplicate_groups SET status = 'dismissed' WHERE id = %s", (group_id,))


# ---- inconsistencies (approximate dependencies) ---------------------------------------------------

def _conflicts(conn: psycopg.Connection, ws_id: int, lhs: list[str], rhs: str) -> list[ConflictOut]:
    """LHS groups holding more than one RHS value, worst first. NULL counts as a value, as in check_fd."""
    n = len(lhs)
    keys = [sql.Identifier(f"l{i}") for i in range(n)]
    key_list = sql.SQL(", ").join(keys)
    rows = conn.execute(sql.SQL(
        "WITH g AS (SELECT {sel}, {rhs} AS v, count(*) AS n FROM {t} GROUP BY {grp}, {rhs}), "
        "     w AS (SELECT g.*, count(*) OVER (PARTITION BY {key_list}) AS nv FROM g) "
        "SELECT {txt}, v::text AS v, n FROM w WHERE nv > 1").format(
            sel=sql.SQL(", ").join(sql.SQL("{} AS {}").format(sql.Identifier(c), k) for c, k in zip(lhs, keys)),
            grp=sql.SQL(", ").join(sql.Identifier(c) for c in lhs), rhs=sql.Identifier(rhs), t=_staging(ws_id),
            key_list=key_list, txt=sql.SQL(", ").join(sql.SQL("{}::text AS {}").format(k, k) for k in keys))
    ).fetchall()
    groups: dict[tuple, list[VariantOut]] = {}
    for r in rows:
        groups.setdefault(tuple(r[f"l{i}"] for i in range(n)), []).append(VariantOut(value=r["v"], rows=r["n"]))
    out = []
    for lhs_values, variants in groups.items():
        # Most frequent first; ties go to the smallest text, NULL last.
        variants.sort(key=lambda v: (-v.rows, v.value is None, v.value or ""))
        out.append(ConflictOut(lhs_values=list(lhs_values), variants=variants, suggested=variants[0].value))
    # Rows that would change if the suggestion were taken, largest first, then by LHS for a stable order.
    out.sort(key=lambda c: (-(sum(v.rows for v in c.variants) - c.variants[0].rows),
                            [(x is None, x or "") for x in c.lhs_values]))
    return out


def inconsistencies(conn: psycopg.Connection, dataset_id: int, limit_per_fd: int = 20) -> list[InconsistencyOut]:
    from qlens.analysis.discover import load_fds        # discover imports this module
    ds = _dataset(conn, dataset_id)
    return [InconsistencyOut(fd_id=f.id, sentence=f.sentence, lhs=f.lhs, rhs=f.rhs,
                             conflicts=_conflicts(conn, ds["workspace_id"], f.lhs, f.rhs)[:limit_per_fd])
            for f in load_fds(conn, dataset_id) if f.accepted and not f.is_exact]


def fix_fd(conn: psycopg.Connection, dataset_id: int, fd_id: int, overrides: dict[str, str] | None) -> int:
    """Make the dependency hold: in each conflicting LHS group set the RHS to the suggested value, or to
    the override keyed by json.dumps(lhs_values). Returns the number of rows changed."""
    from qlens.analysis.discover import load_fds
    ds = _dataset(conn, dataset_id)
    found = load_fds(conn, dataset_id, fd_id)
    if not found:
        raise ApiError(404, "fd_not_found", "Dependency not found.")
    fd = found[0]
    if not fd.accepted:
        raise ApiError(409, "fd_not_accepted", "This dependency was rejected; accept it before fixing the data.")
    cols = {c["name"]: c for c in conn.execute(
        "SELECT id, name, inferred_type FROM qlens.dataset_columns WHERE dataset_id = %s", (dataset_id,))}
    rhs_type = _PG_TYPE[cols[fd.rhs]["inferred_type"]]
    overrides = overrides or {}
    log: dict[tuple[str | None, str | None], int] = {}
    with conn.transaction():
        for conflict in _conflicts(conn, ds["workspace_id"], fd.lhs, fd.rhs):
            target = overrides.get(json.dumps(conflict.lhs_values), conflict.suggested)
            where = sql.SQL(" AND ").join(
                sql.SQL("{} IS NOT DISTINCT FROM CAST(%s AS {})").format(
                    sql.Identifier(c), sql.SQL(_PG_TYPE[cols[c]["inferred_type"]])) for c in fd.lhs)
            for old, rows in _rewrite(conn, ds["workspace_id"], fd.rhs, rhs_type, where,
                                      list(conflict.lhs_values), target).items():
                log[(old, target)] = log.get((old, target), 0) + rows
        for (old, new), rows in log.items():
            _log_fix(conn, dataset_id, "fd_fix", cols[fd.rhs]["id"], old, new, rows)
        refresh_column_profile(conn, ds["workspace_id"], dataset_id, [fd.rhs])
    return sum(log.values())


def accept_all(conn: psycopg.Connection, dataset_id: int) -> "AnalysisOut":
    """One-click cleanup: merge every certain duplicate, then fix every accepted approximate dependency."""
    from qlens.analysis.discover import analyze, load_fds
    with conn.transaction():
        analyze(conn, dataset_id)               # the groups and dependencies below must reflect the data now
        pending = [g for g in load_duplicates(conn, dataset_id)
                   if g.status == "pending" and g.confidence == "same_normalized"]
        for g in pending:
            merge_group(conn, dataset_id, g.id, None)
        analyze(conn, dataset_id)
        for fd in [f for f in load_fds(conn, dataset_id) if f.accepted and not f.is_exact]:
            fix_fd(conn, dataset_id, fd.id, None)
        return analyze(conn, dataset_id)


def list_fixes(conn: psycopg.Connection, dataset_id: int) -> list[FixOut]:
    rows = conn.execute(
        "SELECT f.id, f.kind, c.name AS column, f.from_value, f.to_value, f.rows_affected, f.created_at "
        "FROM qlens.dataset_fixes f JOIN qlens.dataset_columns c ON c.id = f.column_id "
        "WHERE f.dataset_id = %s ORDER BY f.created_at DESC, f.id DESC", (dataset_id,)).fetchall()
    return [FixOut(**r) for r in rows]
