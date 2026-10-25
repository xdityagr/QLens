import pytest
from psycopg import sql

from qlens import db
from qlens.errors import ApiError
from qlens.ingest.stage import import_dataset
from qlens.samples.generate import generate
from test_workspaces import ws_conn


def types_of(ds):
    return {c.name: c.inferred_type for c in ds.columns}


def src_ident(ws_id):
    return sql.Identifier(db.ws_schema(ws_id, "src"))


def test_fee_register_types(conn, workspace):
    ds = import_dataset(conn, workspace, *generate("fee_register"), source="sample")
    types = {c.name: c.inferred_type for c in ds.columns}
    assert types == {"student_name": "text", "student_phone": "text", "batch": "text", "teacher": "text",
                     "teacher_phone": "text", "month": "text", "fee_paid": "integer", "payment_mode": "text"}
    assert ds.row_count == 3000 and ds.column_count == 8 and ds.status == "imported" and ds.source == "sample"
    assert ds.original_filename == "fee_register.csv"
    assert [c.ordinal for c in ds.columns] == list(range(1, 9))
    assert ds.columns[0].label == "Student Name"


def test_kirana_and_hostel_types(conn, workspace):
    ds = import_dataset(conn, workspace, *generate("kirana_sales"), source="sample")
    assert types_of(ds) == {"bill_no": "text", "date": "date", "customer": "text",
                            "customer_phone": "text", "item": "text", "category": "text",
                            "unit_price": "numeric", "qty": "integer", "amount": "numeric"}
    n = conn.execute(sql.SQL("SELECT count(*) AS n FROM {}._staging WHERE date IS NULL").format(
        src_ident(workspace))).fetchone()["n"]
    assert n == 0                                                      # every dd/mm/yyyy parsed
    ds = import_dataset(conn, workspace, *generate("hostel_mess"), source="sample")
    assert types_of(ds) == {"room": "text", "student": "text", "hostel_block": "text", "warden": "text",
                            "date": "date", "meal": "text", "menu_item": "text",
                            "attended": "boolean"}


def test_raw_is_kept_untouched_and_staging_typed(conn, workspace):
    import_dataset(conn, workspace, *generate("fee_register"), source="sample")
    src = db.ws_schema(workspace, "src")

    def one(query):
        return conn.execute(sql.SQL(query).format(sql.Identifier(src))).fetchone()["n"]

    cols = {r["table_name"] + "." + r["column_name"]: r["data_type"] for r in conn.execute(
        "SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = %s", (src,))}
    assert cols["_raw.fee_paid"] == "text" and cols["_staging.fee_paid"] == "bigint"
    assert cols["_raw._row_id"] == "bigint" and cols["_staging._row_id"] == "bigint"
    assert one("SELECT count(*) AS n FROM {}._raw") == 3000
    assert one("SELECT count(*) AS n FROM {}._staging") == 3000
    # _row_id links the two tables and the typed value is the cast of the raw text
    assert one("SELECT count(*) AS n FROM {0}._raw r JOIN {0}._staging s USING (_row_id) "
               "WHERE r.fee_paid::bigint IS DISTINCT FROM s.fee_paid") == 0
    # untouched: the variant spelling is present verbatim in _raw
    assert one("SELECT count(*) AS n FROM {}._raw WHERE student_name = 'Riya  Sharma'") == 1
    pk = conn.execute("SELECT count(*) AS n FROM information_schema.table_constraints "
                      "WHERE table_schema = %s AND table_name IN ('_raw', '_staging') "
                      "AND constraint_type = 'PRIMARY KEY'", (src,)).fetchone()["n"]
    assert pk == 2
    # unpaid rows have an empty payment mode -> NULL, not ''
    assert one("SELECT count(*) AS n FROM {}._raw WHERE payment_mode = ''") == 0
    assert one("SELECT count(*) AS n FROM {}._staging WHERE fee_paid = 0 AND payment_mode IS NULL") > 100


def test_profile(conn, workspace):
    ds = import_dataset(conn, workspace, *generate("fee_register"), source="sample")
    by = {c.name: c for c in ds.columns}
    assert by["batch"].distinct_count == 8 and by["batch"].null_count == 0
    assert len(by["batch"].sample_values) == 5
    assert by["student_phone"].distinct_count == 300
    assert by["month"].distinct_count == 10
    assert 150 < by["payment_mode"].null_count < 350 and by["payment_mode"].distinct_count == 3
    assert by["fee_paid"].sample_values[0] in {"4000", "3500", "2500", "0"}
    # sample values come most-frequent first
    counts = {r["batch"]: r["n"] for r in conn.execute(sql.SQL(
        "SELECT batch, count(*) AS n FROM {}._staging GROUP BY 1").format(src_ident(workspace)))}
    assert counts[by["batch"].sample_values[0]] == max(counts.values())
    rows = conn.execute("SELECT sample_values FROM qlens.dataset_columns "
                        "WHERE dataset_id = %s AND name = 'batch'", (ds.id,)).fetchall()
    assert rows[0]["sample_values"] == by["batch"].sample_values


def test_reimport_replaces_dataset(conn, workspace):
    first = import_dataset(conn, workspace, *generate("fee_register"), source="sample")
    # simulate objects a later step created in main/lab
    conn.execute(sql.SQL("CREATE TABLE {}.leftover (x int)").format(sql.Identifier(db.ws_schema(workspace, "main"))))
    db.create_ws_schema(conn, workspace, "lab")
    second = import_dataset(conn, workspace, "tiny.csv", b"A,B\n1,x\n2,y\n", source="upload")
    assert second.id != first.id and second.source == "upload" and second.row_count == 2
    assert conn.execute("SELECT count(*) AS n FROM qlens.datasets WHERE workspace_id = %s",
                        (workspace,)).fetchone()["n"] == 1
    assert conn.execute("SELECT count(*) AS n FROM qlens.dataset_columns WHERE dataset_id = %s",
                        (first.id,)).fetchone()["n"] == 0
    schemas = {r["nspname"] for r in conn.execute("SELECT nspname FROM pg_namespace WHERE nspname LIKE %s",
                                                  (f"ws\\_{workspace}%",))}
    assert schemas == {f"ws_{workspace}", f"ws_{workspace}_src"}      # lab dropped, main emptied, src rebuilt
    assert conn.execute("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = %s",
                        (f"ws_{workspace}",)).fetchone()["n"] == 0
    assert conn.execute(sql.SQL("SELECT count(*) AS n FROM {}._staging").format(
        src_ident(workspace))).fetchone()["n"] == 2


def test_failed_import_keeps_previous_dataset(conn, workspace):
    first = import_dataset(conn, workspace, *generate("hostel_mess"), source="sample")
    with pytest.raises(ApiError):
        import_dataset(conn, workspace, "bad.csv", b"a,b\n", source="upload")
    ds = conn.execute("SELECT id FROM qlens.datasets WHERE workspace_id = %s", (workspace,)).fetchone()
    assert ds["id"] == first.id


def test_inference_rules(conn, workspace):
    csv_text = (
        "int_col,big_int,dec_col,lead_zero,bool_col,date_iso,date_dmy,bad_date,mixed,all_null\n"
        "1,123456789,1.5,007,Yes,2026-04-01,31/12/2026,2026-02-30,1,\n"
        "-2,1234567890,+2,12,no,2026-04-02,1-2-2026,2026-01-01,x,\n"
        ",,,,,,,,,\n"
        "0,5,3.25,1,Y,2026-04-03,01/01/2027,2026-03-01,2,\n"
    )
    ds = import_dataset(conn, workspace, "t.csv", csv_text.encode(), source="upload")
    assert types_of(ds) == {"int_col": "integer", "big_int": "numeric", "dec_col": "numeric",
                            "lead_zero": "text", "bool_col": "boolean", "date_iso": "date",
                            "date_dmy": "date", "bad_date": "text", "mixed": "text", "all_null": "text"}
    assert ds.row_count == 3                                          # fully empty row skipped
    rows = conn.execute(sql.SQL("SELECT bool_col, date_dmy, dec_col FROM {}._staging ORDER BY _row_id").format(
        src_ident(workspace))).fetchall()
    assert [r["bool_col"] for r in rows] == [True, False, True]
    assert [str(r["date_dmy"]) for r in rows] == ["2026-12-31", "2026-02-01", "2027-01-01"]   # day-first
    assert [str(r["dec_col"]) for r in rows] == ["1.5", "2", "3.25"]


def test_try_date(conn):
    def d(p):
        return conn.execute("SELECT qlens.try_date(%s) AS d", (p,)).fetchone()["d"]
    assert str(d("31/12/2026")) == "2026-12-31"
    assert str(d("1-2-2026")) == "2026-02-01"
    assert str(d("2026-04-30")) == "2026-04-30"
    assert d("2026-02-30") is None and d("31/02/2026") is None and d("13/13/2026") is None
    assert d("Apr") is None and d("") is None and d("2026/04/01") is None and d("1/2/26") is None


def test_sandbox_role_can_select_but_not_write(conn, workspace, test_url):
    import_dataset(conn, workspace, *generate("hostel_mess"), source="sample")
    conn.commit()
    src = db.ws_schema(workspace, "src")
    with ws_conn(test_url, workspace) as w:
        assert w.execute(f"SELECT count(*) AS n FROM {src}._staging").fetchone()["n"] == 2520
        assert w.execute(f"SELECT count(*) AS n FROM {src}._raw").fetchone()["n"] == 2520
        assert w.execute("SELECT count(*) AS n FROM _staging").fetchone()["n"] == 2520    # via search_path
        w.rollback()
        with pytest.raises(Exception, match="permission denied|read-only"):
            w.execute(f"DELETE FROM {src}._staging")


def test_sample_fixtures_are_independent(fee_ws, kirana_ws, hostel_ws, conn):
    assert len({fee_ws.id, kirana_ws.id, hostel_ws.id}) == 3
    assert len({fee_ws.dataset_id, kirana_ws.dataset_id, hostel_ws.dataset_id}) == 3
    for ws, rows, filename in ((fee_ws, 3000, "fee_register.csv"), (kirana_ws, None, "kirana_sales.csv"),
                               (hostel_ws, 2520, "hostel_mess.csv")):
        ds = conn.execute("SELECT id, workspace_id, row_count, original_filename FROM qlens.datasets "
                          "WHERE id = %s", (ws.dataset_id,)).fetchone()
        assert ds["workspace_id"] == ws.id and ds["original_filename"] == filename
        staged = conn.execute(sql.SQL("SELECT count(*) AS n FROM {}._staging").format(src_ident(ws.id))).fetchone()["n"]
        assert staged == ds["row_count"] and (rows is None or staged == rows)
    owners = {r["owner_id"] for r in conn.execute("SELECT owner_id FROM qlens.workspaces")}
    assert len(owners) == 3                                            # a fresh user per workspace
