"""Applying a proposal: build its tables in ws_<id> and prove, with EXCEPT ALL, that the sheet comes back whole.

Everything runs in one transaction (a savepoint when the caller already has one open). When the check finds a
difference, the error undoes it all: the previous tables, the lab and every proposal status stay as they were.
"""
import time
from typing import TypedDict

import psycopg
from psycopg import sql
from pydantic import BaseModel

from qlens import db
from qlens.design import ddl, proposal
from qlens.design.proposal import VIEW_NAME, ProposalOut
from qlens.errors import ApiError

SAMPLE_ROWS = 5


class AppliedTable(TypedDict):
    name: str
    row_count: int
    color_index: int


class ApplyOut(BaseModel):
    ok: bool
    lossless_ok: bool
    staging_rows: int
    reconstructed_rows: int
    mismatch_rows: int
    tables: list[AppliedTable]
    duration_ms: int
    sql: str


def _draft(conn: psycopg.Connection, ws_id: int, proposal_id: int) -> dict:
    # FOR UPDATE: a concurrent build or apply of the same draft waits, then sees its new status.
    row = conn.execute(
        "SELECT p.id, p.dataset_id, p.status FROM qlens.schema_proposals p "
        "JOIN qlens.datasets d ON d.id = p.dataset_id WHERE p.id = %s AND d.workspace_id = %s FOR UPDATE OF p",
        (proposal_id, ws_id)).fetchone()
    if row is None:
        raise ApiError(404, "proposal_not_found", "Design not found.")
    if row["status"] != "draft":
        raise ApiError(409, "proposal_not_draft", "Only the current draft can be applied; build a new design first.")
    return row


def _mismatch_sample(conn: psycopg.Connection, p: ProposalOut, ws_id: int) -> list[dict]:
    """Up to SAMPLE_ROWS rows that differ: 'missing' rows are in the sheet but not rebuilt, 'extra' the reverse."""
    cols = sql.SQL(", ").join(map(sql.Identifier, p.source_columns))
    view = sql.Identifier(db.ws_schema(ws_id, "main"), VIEW_NAME)
    staging = sql.Identifier(db.ws_schema(ws_id, "src"), "_staging")
    sample: list[dict] = []
    for side, a, b in (("missing", staging, view), ("extra", view, staging)):
        rows = conn.execute(sql.SQL(
            "SELECT to_jsonb(d) AS row FROM (SELECT {cols} FROM {a} EXCEPT ALL SELECT {cols} FROM {b}) d LIMIT {n}"
        ).format(cols=cols, a=a, b=b, n=sql.Literal(SAMPLE_ROWS - len(sample)))).fetchall()
        sample += [{"side": side, "row": r["row"]} for r in rows]
        if len(sample) >= SAMPLE_ROWS:
            break
    return sample


def apply_proposal(conn: psycopg.Connection, ws_id: int, proposal_id: int) -> ApplyOut:
    started = time.perf_counter()
    main = db.ws_schema(ws_id, "main")
    with conn.transaction():
        row = _draft(conn, ws_id, proposal_id)
        p = proposal.get_proposal(conn, proposal_id)
        steps = ddl.render(p, ws_id)
        script = ddl.as_text(steps, conn)

        # The lab is a scratch copy of the old tables, so it goes with them.
        db.drop_ws_schema(conn, ws_id, "lab")
        db.drop_ws_schema(conn, ws_id, "main")
        db.create_ws_schema(conn, ws_id, "main")
        verify = None
        for step in steps:
            cur = conn.execute(step.sql)
            if step.kind == "verify":
                verify = cur.fetchone()
        if verify is None:
            raise RuntimeError("the generated script has no verify step")

        mismatch = verify["extra_rows"] + verify["missing_rows"]
        if mismatch:
            raise ApiError(
                409, "lossless_check_failed",
                f"The new tables do not give back the original sheet ({mismatch} row(s) differ); nothing was changed.",
                detail={"mismatch_rows": mismatch, "extra_rows": verify["extra_rows"],
                        "missing_rows": verify["missing_rows"], "sample": _mismatch_sample(conn, p, ws_id)})

        tables = [AppliedTable(
            name=t.name, color_index=t.color_index,
            row_count=conn.execute(sql.SQL("SELECT count(*) AS n FROM {}").format(
                sql.Identifier(main, t.name))).fetchone()["n"])
            for t in p.tables]

        # Superseded first: at most one applied proposal per dataset (a partial unique index).
        conn.execute("UPDATE qlens.schema_proposals SET status = 'superseded' "
                     "WHERE dataset_id = %s AND status = 'applied'", (row["dataset_id"],))
        conn.execute(
            "UPDATE qlens.schema_proposals SET status = 'applied', applied_at = now(), lossless_ok = true, "
            "staging_rows = %s, reconstructed_rows = %s, mismatch_rows = 0 WHERE id = %s",
            (verify["staging_rows"], verify["reconstructed_rows"], proposal_id))
        conn.execute("UPDATE qlens.datasets SET status = 'applied' WHERE id = %s", (row["dataset_id"],))

    # Fresh statistics, so the first queries and EXPLAINs on the new tables get sensible plans.
    for t in p.tables:
        conn.execute(sql.SQL("ANALYZE {}").format(sql.Identifier(main, t.name)))
    return ApplyOut(ok=True, lossless_ok=True, staging_rows=verify["staging_rows"],
                    reconstructed_rows=verify["reconstructed_rows"], mismatch_rows=0, tables=tables,
                    duration_ms=round((time.perf_counter() - started) * 1000), sql=script)
