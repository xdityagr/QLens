import io
from datetime import date, datetime

import pytest
from openpyxl import Workbook

from qlens.errors import ApiError
from qlens.ingest import parse
from qlens.ingest.parse import read_table, sanitize_names


def test_bom_and_cp1252():
    t = read_table("a.csv", "﻿Name,City\nAsha,Pune\n".encode("utf-8")); assert t.names == ["name", "city"]
    t = read_table("b.csv", "Name,Note\nZo\xe9,Caf\xe9\n".encode("cp1252")); assert t.rows[0] == ["Zoé", "Café"]


def test_bad_headers_and_ragged_rows():
    t = read_table("c.csv", b"Name,Name,,1st Score\nA,B\nC,D,E,F,G\n,,,\n")
    assert t.names == ["name", "name_2", "column_3", "c_1st_score"]
    assert t.labels == ["Name", "Name", "column_3", "1st Score"]
    assert t.rows == [["A", "B", None, None], ["C", "D", "E", "F"]]


def test_cells_are_stripped_and_empty_is_null():
    t = read_table("d.csv", b"a,b\n  x  ,\n,   \n1,2\n")
    assert t.rows == [["x", None], ["1", "2"]]


@pytest.mark.parametrize("sep", [";", "\t", "|", ","])
def test_delimiter_sniffing(sep):
    rows = [["id", "city", "score"], ["1", "Pune", "9"], ["2", "Delhi", "7"], ["3", "Goa", "8"]]
    t = read_table("x.csv", "\n".join(sep.join(r) for r in rows).encode())
    assert t.names == ["id", "city", "score"] and t.rows[1] == ["2", "Delhi", "7"]


def test_single_column_and_quoted_commas():
    assert read_table("x.csv", b"name\nAsha\nBen\n").rows == [["Asha"], ["Ben"]]
    t = read_table("x.csv", b'name,addr\nAsha,"12, Main St"\n')
    assert t.rows == [["Asha", "12, Main St"]]


def _xlsx(rows) -> bytes:
    wb = Workbook(); ws = wb.active
    for r in rows:
        ws.append(r)
    wb.create_sheet("second").append(["ignored"])
    buf = io.BytesIO(); wb.save(buf)
    return buf.getvalue()


def test_xlsx_dates_and_numbers():
    data = _xlsx([["Date", "Fee", "Rate", "Ok", "Note"],
                  [date(2026, 4, 1), 4000.0, 12.5, True, "x"],
                  [datetime(2026, 5, 2), 3500, 0.1, False, None]])
    t = read_table("fees.xlsx", data)
    assert t.names == ["date", "fee", "rate", "ok", "note"]
    assert t.rows[0] == ["2026-04-01", "4000", "12.5", "true", "x"]
    assert t.rows[1] == ["2026-05-02", "3500", "0.1", "false", None]


def test_xlsx_trailing_empty_columns_dropped():
    t = read_table("a.xlsx", _xlsx([["a", "b", None, None], [1, 2, None, None]]))
    assert t.names == ["a", "b"] and t.rows == [["1", "2"]]


def test_limits_and_errors(monkeypatch):
    def code(filename, data):
        with pytest.raises(ApiError) as e:
            read_table(filename, data)
        assert e.value.status == 422
        return e.value.code

    wide = (",".join(f"c{i}" for i in range(61)) + "\n" + ",".join("1" * 61) + "\n").encode()
    assert code("w.csv", wide) == "too_many_columns"
    assert read_table("w.csv", (",".join(f"c{i}" for i in range(60)) + "\n1\n").encode()).names[59] == "c59"
    assert code("e.csv", b"") == "empty_file"
    assert code("e.csv", b"a,b\n") == "empty_file"                    # header only
    assert code("e.csv", b"\n\n,,\n") == "empty_file"
    assert code("notes.pdf", b"%PDF") == "unsupported_file"
    assert code("bad.xlsx", b"not a zip") == "unsupported_file"
    assert code("big.csv", b"a\n" + b"x" * (20 * 1024 * 1024)) == "file_too_large"
    monkeypatch.setattr(parse, "MAX_ROWS", 3)
    assert code("r.csv", b"a\n1\n2\n3\n4\n") == "too_many_rows"
    assert len(read_table("r.csv", b"a\n1\n2\n3\n").rows) == 3


def test_sanitize_names():
    assert sanitize_names(["Student Name", "Fee (₹)", "Date (dd/mm/yyyy)", "Caf\xe9", "", "9lives", "_x",
                           "A-B", "a b"]) == ["student_name", "fee", "date_dd_mm_yyyy", "cafe", "column_5",
                                              "c_9lives", "x", "a_b", "a_b_2"]
    assert sanitize_names(["a", "a", "a", "a_2"]) == ["a", "a_2", "a_3", "a_2_2"]
    long = "x" * 80
    names = sanitize_names([long, long])
    assert all(len(n) <= 63 for n in names) and names[0] != names[1] and names[1].endswith("_2")
    assert sanitize_names(["???"]) == ["column_1"]
