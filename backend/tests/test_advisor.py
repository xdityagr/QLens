from qlens.perf.advisor import _filter_columns, index_name, suggest
from qlens.perf.explain import explain
from qlens.perf.lab import try_index

QUERY = "SELECT * FROM fee_register WHERE student_id = 5"


def test_advisor_suggests_filter_column(conn, applied_fee_scaled):
    ws = applied_fee_scaled.id
    plan = explain(conn, ws, QUERY, "lab")
    [s] = suggest(conn, ws, plan, "lab")
    assert (s.table, s.columns) == ("fee_register", ["student_id"])
    assert s.reason == ("Seq Scan read 30,000 rows of fee_register to keep 100 — an index on (student_id) lets "
                        "Postgres jump straight to them.")
    assert s.ddl == f"CREATE INDEX ix_fee_register_student_id ON ws_{ws}_lab.fee_register (student_id)"


def test_advisor_skips_existing_index(conn, applied_fee_scaled):
    ws = applied_fee_scaled.id
    e = try_index(conn, ws, QUERY, "fee_register", ["student_id"], runs=1)
    assert suggest(conn, ws, explain(conn, ws, QUERY, "lab"), "lab") == []
    # Even a plan that still seq-scans gets no suggestion once an index leads with the column.
    assert e.before_plan.nodes[0].node_type == "Seq Scan"
    assert suggest(conn, ws, e.before_plan, "lab") == []


def test_advisor_ignores_unselective_filters(conn, applied_fee_scaled):
    ws = applied_fee_scaled.id
    # About 92% of the rows are paid: reading them all is the right plan.
    plan = explain(conn, ws, "SELECT * FROM fee_register WHERE fee_paid > 0", "lab")
    assert plan.nodes[0].node_type == "Seq Scan" and suggest(conn, ws, plan, "lab") == []


def test_advisor_hash_join_side(conn, applied_fee_scaled):
    ws = applied_fee_scaled.id
    # One student's 100 fee rows: the planner hashes the one student and reads all 30,000 fee rows to match them.
    plan = explain(conn, ws, "SELECT * FROM fee_register f JOIN students s ON s.id = f.student_id "
                             "WHERE s.student_name = 'Aarav Desai'", "lab")
    assert [n.node_type for n in plan.nodes] == ["Hash Join", "Seq Scan", "Hash", "Seq Scan"]
    by_table = {s.table: s for s in suggest(conn, ws, plan, "lab")}
    assert {t: s.columns for t, s in by_table.items()} == {"fee_register": ["student_id"],
                                                           "students": ["student_name"]}
    assert by_table["fee_register"].reason.startswith("Hash Join read all 30,000 rows of fee_register to match 100")


def test_filter_columns():
    f = {"f", "fee_register"}
    assert _filter_columns("(student_id = 5)", f) == ["student_id"]
    assert _filter_columns("(5 = student_id)", f) == ["student_id"]
    # Equality first, whatever the order in the filter; at most three columns.
    assert _filter_columns("((f.amount > '100'::numeric) AND (f.month = 'Apr'::text) AND (f.b = 1) AND (f.c = 2))",
                           f) == ["month", "b", "c"]
    assert _filter_columns("(student_id = ANY ('{1,2}'::bigint[]))", f) == ["student_id"]
    assert _filter_columns("((mode)::text ~~ 'Ca%'::text)", f) == []          # a cast column: no plain index helps
    assert _filter_columns("(mode ~~ 'Ca%'::text)", f) == ["mode"]
    assert _filter_columns("(mode ~~ '%sh'::text)", f) == []                   # no fixed prefix
    assert _filter_columns("((x = 1) OR (y = 2))", f) == []                    # one index cannot serve both
    assert _filter_columns("((x = 1) AND ((y = 2) OR (z = 3)))", f) == ["x"]
    assert _filter_columns("(f.a = f.b)", f) == []                             # columns on both sides
    assert _filter_columns("(s.a = 1)", f) == []                               # another relation's column
    assert _filter_columns("(hashed SubPlan 1)", f) == []                      # not parseable as SQL


def test_index_name_fits():
    assert index_name("fee_register", ["student_id"]) == "ix_fee_register_student_id"
    long = index_name("t" * 40, ["c" * 30, "d" * 30])
    assert len(long) == 63 and len(index_name("t" * 40, ["c" * 30, "d" * 30], 2)) == 63
    assert index_name("t" * 40, ["c" * 30, "d" * 30], 2).endswith("_2")
