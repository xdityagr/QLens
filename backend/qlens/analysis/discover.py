"""Candidate keys and functional dependencies, discovered by SQL (qlens.check_fd / qlens.is_unique)."""
import itertools
import math
import re

import psycopg
from pydantic import BaseModel

from qlens import db
from qlens.analysis import cleanup
from qlens.analysis.fd_algebra import FD, minimal_cover
from qlens.errors import ApiError
from qlens.ingest.stage import ColumnOut

LEVEL2_MAX_ELIGIBLE = 20      # pairs (and key triples) are only tried on narrow tables
APPROX_THRESHOLD = 0.02

# An integer/numeric column is a measure (fee, quantity) unless its name says it is an identifier.
_ID_NAME = re.compile(r"(^|_)(id|no|num|number|code)$")


class FDOut(BaseModel):
    id: int
    lhs: list[str]
    rhs: str
    is_exact: bool
    violating_rows: int
    violation_ratio: float
    accepted: bool
    # Exact, accepted and implied by the other exact accepted FDs (not part of the minimal cover).
    is_derived: bool
    sentence: str


class AnalysisOut(BaseModel):
    dataset_id: int
    row_count: int
    keys: list[list[str]]
    fds: list[FDOut]
    duplicates: list[cleanup.DuplicateGroupOut]
    inconsistencies: list[cleanup.InconsistencyOut]


def lhs_eligible(col: ColumnOut) -> bool:
    """Can this column plausibly be the determinant of something? Measures and flags cannot."""
    if col.inferred_type == "boolean" or col.distinct_count <= 1:
        return False
    if col.inferred_type in ("integer", "numeric"):
        return bool(_ID_NAME.search(col.name))
    return True


def sentence(lhs_labels: list[str], rhs_label: str, violating_rows: int) -> str:
    text = f"Each {' + '.join(lhs_labels)} has exactly one {rhs_label}"
    if violating_rows:
        text += f" except in {violating_rows} row{'s' if violating_rows != 1 else ''}"
    return text


# ---- discovery ------------------------------------------------------------------------------------

def _load_columns(conn: psycopg.Connection, dataset_id: int) -> list[ColumnOut]:
    rows = conn.execute(
        "SELECT id, ordinal, name, label, inferred_type, null_count, distinct_count, sample_values "
        "FROM qlens.dataset_columns WHERE dataset_id = %s ORDER BY ordinal", (dataset_id,)).fetchall()
    return [ColumnOut(**r) for r in rows]


def _find_keys(conn: psycopg.Connection, schema: str, row_count: int,
               cols: list[ColumnOut], eligible: list[ColumnOut]) -> list[tuple[str, ...]]:
    keys: list[tuple[str, ...]] = []

    def is_key(combo: tuple[ColumnOut, ...]) -> bool:
        names = tuple(c.name for c in combo)
        if any(set(k) <= set(names) for k in keys):
            return False                       # a superset of a smaller key is not a new key
        if any(c.null_count > 0 for c in combo):
            return False                       # a key must be filled in on every row
        # Necessary condition from the import profile, so most combinations never reach the database.
        if math.prod(c.distinct_count for c in combo) < row_count:
            return False
        return bool(conn.execute("SELECT qlens.is_unique(%s, '_staging', %s) AS u",
                                 (schema, list(names))).fetchone()["u"])

    for c in cols:
        if is_key((c,)):
            keys.append((c.name,))
    for size in (2, 3):
        if size == 3 and (keys or len(eligible) > LEVEL2_MAX_ELIGIBLE):
            break
        for combo in itertools.combinations(eligible, size):
            if is_key(combo):
                keys.append(tuple(c.name for c in combo))
    return keys


def _find_fds(conn: psycopg.Connection, schema: str, cols: list[ColumnOut], eligible: list[ColumnOut],
              keys: list[tuple[str, ...]]) -> list[dict]:
    """Dicts with lhs (names), rhs (name) and the check_fd measures."""
    key_sets = [set(k) for k in keys]
    non_constant = [c for c in cols if c.distinct_count > 1]
    ordinal = {c.name: c.ordinal for c in cols}

    def check(names: list[str], rhs: str) -> dict | None:
        m = conn.execute("SELECT * FROM qlens.check_fd(%s, '_staging', %s, %s)", (schema, names, rhs)).fetchone()
        if m["repeated_groups"] >= 2 and m["violating_rows"] <= APPROX_THRESHOLD * m["row_count"]:
            return {"lhs": names, "rhs": rhs, **m}
        return None

    # Level 1: every candidate, before any suppression (the later rules compare against all of them).
    singles: dict[tuple[str, str], dict] = {}
    for c in eligible:
        if any(k <= {c.name} for k in key_sets):
            continue                                # a key determines everything; nothing to learn
        for rhs in non_constant:
            if rhs.name != c.name and (fd := check([c.name], rhs.name)):
                singles[(c.name, rhs.name)] = fd
    exact_single = {k for k, fd in singles.items() if fd["violating_rows"] == 0}

    found: list[dict] = []
    # Level 2.
    if len(eligible) <= LEVEL2_MAX_ELIGIBLE:
        for pair in itertools.combinations(eligible, 2):
            names = [c.name for c in pair]
            if any(k <= set(names) for k in key_sets):
                continue
            for rhs in non_constant:
                if rhs.name in names or any((n, rhs.name) in exact_single for n in names):
                    continue                        # already determined exactly by part of the LHS
                fd = check(names, rhs.name)
                if fd is None:
                    continue
                # A part of the LHS already (nearly) determines r. A finer grouping can only have fewer
                # violations, so the pair would just isolate the dirty rows and look like a clean FD.
                if any((n, rhs.name) in singles for n in names):
                    continue
                found.append(fd)

    # Root cause: if X -> Z holds exactly and Z -> r (nearly) holds, the broken X -> r is the same
    # inconsistency seen through Z, so only Z -> r is kept. Z's groups are unions of X's groups, so
    # Z -> r never has fewer violations than X -> r; no comparison of counts is needed. Equivalent
    # columns (X <-> Z) are ordered by position so that exactly one of them keeps the dependency.
    def upstream(x: str, z: str) -> bool:
        return (x, z) in exact_single and ((z, x) not in exact_single or ordinal[z] < ordinal[x])

    for (x, r), fd in singles.items():
        if fd["violating_rows"] > 0 and any(
                z != r and upstream(x, z) and (z, r) in singles
                for z in {zz for (xx, zz) in exact_single if xx == x}):
            continue
        found.append(fd)
    return found


def analyze(conn: psycopg.Connection, dataset_id: int) -> AnalysisOut:
    ds = conn.execute("SELECT workspace_id, row_count FROM qlens.datasets WHERE id = %s", (dataset_id,)).fetchone()
    if ds is None:
        raise ApiError(404, "no_dataset", "This workspace has no dataset yet.")
    schema = db.ws_schema(ds["workspace_id"], "src")
    cols = _load_columns(conn, dataset_id)
    by_name = {c.name: c for c in cols}
    eligible = [c for c in cols if lhs_eligible(c)]

    with conn.transaction():
        # Rejections survive re-analysis, keyed by what the dependency says (LHS set + RHS).
        rejected = {(frozenset(f.lhs), f.rhs) for f in load_fds(conn, dataset_id) if not f.accepted}
        conn.execute("DELETE FROM qlens.candidate_keys WHERE dataset_id = %s", (dataset_id,))
        conn.execute("DELETE FROM qlens.functional_dependencies WHERE dataset_id = %s", (dataset_id,))

        keys = _find_keys(conn, schema, ds["row_count"], cols, eligible)
        for key in keys:
            key_id = conn.execute("INSERT INTO qlens.candidate_keys (dataset_id, key_size) VALUES (%s, %s) "
                                  "RETURNING id", (dataset_id, len(key))).fetchone()["id"]
            for name in key:
                conn.execute("INSERT INTO qlens.candidate_key_columns (key_id, column_id) VALUES (%s, %s)",
                             (key_id, by_name[name].id))

        for fd in _find_fds(conn, schema, cols, eligible, keys):
            fd_id = conn.execute(
                "INSERT INTO qlens.functional_dependencies (dataset_id, rhs_column_id, lhs_size, row_count, "
                "lhs_values, repeated_groups, violating_rows, accepted) VALUES (%s, %s, %s, %s, %s, %s, %s, %s) "
                "RETURNING id",
                (dataset_id, by_name[fd["rhs"]].id, len(fd["lhs"]), fd["row_count"], fd["lhs_values"],
                 fd["repeated_groups"], fd["violating_rows"],
                 (frozenset(fd["lhs"]), fd["rhs"]) not in rejected)).fetchone()["id"]
            for name in fd["lhs"]:
                conn.execute("INSERT INTO qlens.fd_lhs_columns (fd_id, column_id) VALUES (%s, %s)",
                             (fd_id, by_name[name].id))
        cleanup.find_duplicates(conn, dataset_id)
        conn.execute("UPDATE qlens.datasets SET status = 'analyzed' WHERE id = %s AND status = 'imported'",
                     (dataset_id,))
    return get_analysis(conn, dataset_id)


# ---- read -----------------------------------------------------------------------------------------

_FD_SQL = """
SELECT f.id, f.violating_rows, f.is_exact, COALESCE(f.violation_ratio, 0)::float8 AS violation_ratio,
       f.accepted, rc.name AS rhs, rc.label AS rhs_label,
       array_agg(lc.name ORDER BY lc.ordinal) AS lhs, array_agg(lc.label ORDER BY lc.ordinal) AS lhs_labels
FROM qlens.functional_dependencies f
JOIN qlens.dataset_columns rc ON rc.id = f.rhs_column_id
JOIN qlens.fd_lhs_columns l ON l.fd_id = f.id
JOIN qlens.dataset_columns lc ON lc.id = l.column_id
WHERE f.dataset_id = %(ds)s
GROUP BY f.id, rc.name, rc.label, rc.ordinal
ORDER BY f.lhs_size, min(lc.ordinal), max(lc.ordinal), rc.ordinal
"""


def load_fds(conn: psycopg.Connection, dataset_id: int, fd_id: int | None = None) -> list[FDOut]:
    rows = conn.execute(_FD_SQL, {"ds": dataset_id}).fetchall()
    order = [r["name"] for r in conn.execute(
        "SELECT name FROM qlens.dataset_columns WHERE dataset_id = %s ORDER BY ordinal", (dataset_id,))]
    cover = {(fd.lhs, fd.rhs) for fd in minimal_cover(
        [FD(frozenset(r["lhs"]), r["rhs"]) for r in rows if r["is_exact"] and r["accepted"]], order)}
    out = [FDOut(id=r["id"], lhs=r["lhs"], rhs=r["rhs"], is_exact=r["is_exact"],
                 violating_rows=r["violating_rows"], violation_ratio=r["violation_ratio"],
                 accepted=r["accepted"],
                 is_derived=r["is_exact"] and r["accepted"] and (frozenset(r["lhs"]), r["rhs"]) not in cover,
                 sentence=sentence(r["lhs_labels"], r["rhs_label"], r["violating_rows"]))
           for r in rows]
    return [f for f in out if fd_id is None or f.id == fd_id]


def to_algebra(fds: list[FDOut]) -> list[FD]:
    """Exact and accepted dependencies, in the form the 3NF synthesis consumes."""
    return [FD(frozenset(f.lhs), f.rhs) for f in fds if f.is_exact and f.accepted]


def get_analysis(conn: psycopg.Connection, dataset_id: int) -> AnalysisOut:
    ds = conn.execute("SELECT row_count FROM qlens.datasets WHERE id = %s", (dataset_id,)).fetchone()
    keys = conn.execute(
        "SELECT array_agg(c.name ORDER BY c.ordinal) AS cols FROM qlens.candidate_keys k "
        "JOIN qlens.candidate_key_columns kc ON kc.key_id = k.id JOIN qlens.dataset_columns c ON c.id = kc.column_id "
        "WHERE k.dataset_id = %s GROUP BY k.id ORDER BY k.key_size, min(c.ordinal), max(c.ordinal)", (dataset_id,))
    return AnalysisOut(dataset_id=dataset_id, row_count=ds["row_count"], keys=[r["cols"] for r in keys],
                       fds=load_fds(conn, dataset_id), duplicates=cleanup.load_duplicates(conn, dataset_id),
                       inconsistencies=cleanup.inconsistencies(conn, dataset_id))
