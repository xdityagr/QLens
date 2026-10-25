import pytest

CREDS = {"email": "ing@x.com", "password": "correct horse", "display_name": "Ing"}
OTHER = {"email": "oth@x.com", "password": "another pass", "display_name": "Oth"}


@pytest.fixture
def ws_id(client):
    client.post("/api/auth/signup", json=CREDS)
    return client.post("/api/workspaces", json={"name": "Imports"}).json()["id"]


def test_requires_login_and_ownership(client, second_client, ws_id):
    anon = second_client
    for r in (anon.get(f"/api/workspaces/{ws_id}/dataset"),
              anon.post(f"/api/workspaces/{ws_id}/dataset/sample", json={"name": "fee_register"}),
              anon.post(f"/api/workspaces/{ws_id}/dataset", files={"file": ("a.csv", b"a\n1\n")})):
        assert r.status_code == 401
    anon.post("/api/auth/signup", json=OTHER)
    for r in (anon.get(f"/api/workspaces/{ws_id}/dataset"),
              anon.post(f"/api/workspaces/{ws_id}/dataset/sample", json={"name": "fee_register"}),
              anon.post(f"/api/workspaces/{ws_id}/dataset", files={"file": ("a.csv", b"a\n1\n")})):
        assert r.status_code == 404 and r.json()["error"]["code"] == "workspace_not_found"


def test_no_dataset_yet(client, ws_id):
    r = client.get(f"/api/workspaces/{ws_id}/dataset")
    assert r.status_code == 404 and r.json()["error"]["code"] == "no_dataset"


def test_sample_import_and_get(client, ws_id):
    r = client.post(f"/api/workspaces/{ws_id}/dataset/sample", json={"name": "fee_register"})
    assert r.status_code == 201
    ds = r.json()
    assert set(ds) == {"id", "original_filename", "source", "row_count", "column_count", "status", "columns"}
    assert ds["row_count"] == 3000 and ds["source"] == "sample" and ds["status"] == "imported"
    assert set(ds["columns"][0]) == {"id", "ordinal", "name", "label", "inferred_type", "null_count",
                                     "distinct_count", "sample_values"}
    got = client.get(f"/api/workspaces/{ws_id}/dataset").json()
    preview = got.pop("preview")
    assert got == ds
    assert preview["columns"] == [c["name"] for c in ds["columns"]]
    assert len(preview["rows"]) == 50 and len(preview["rows"][0]) == 8
    assert preview["rows"][0][preview["columns"].index("fee_paid")] in (0, 2500, 3500, 4000)
    # workspace summary now reflects the dataset
    summary = client.get(f"/api/workspaces/{ws_id}").json()
    assert summary["stage"] == "imported" and summary["row_count"] == 3000 and summary["column_count"] == 8


def test_preview_serialises_typed_values(client, ws_id):
    client.post(f"/api/workspaces/{ws_id}/dataset/sample", json={"name": "kirana_sales"})
    p = client.get(f"/api/workspaces/{ws_id}/dataset").json()["preview"]
    row = dict(zip(p["columns"], p["rows"][0]))
    assert row["date_dd_mm_yyyy"][4] == "-"                          # ISO date string
    assert isinstance(row["qty"], int) and isinstance(row["unit_price"], str)   # numeric kept exact as text


def test_bad_sample_name(client, ws_id):
    r = client.post(f"/api/workspaces/{ws_id}/dataset/sample", json={"name": "nope"})
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"


def test_upload_csv_and_replace(client, ws_id):
    r = client.post(f"/api/workspaces/{ws_id}/dataset", files={"file": ("my data.csv", b"Name,Qty\nA,1\nB,2\n")})
    assert r.status_code == 201
    ds = r.json()
    assert ds["source"] == "upload" and ds["original_filename"] == "my data.csv" and ds["row_count"] == 2
    assert [c["inferred_type"] for c in ds["columns"]] == ["text", "integer"]
    r = client.post(f"/api/workspaces/{ws_id}/dataset/sample", json={"name": "hostel_mess"})
    assert r.status_code == 201 and r.json()["id"] != ds["id"]
    assert client.get(f"/api/workspaces/{ws_id}/dataset").json()["row_count"] == 2520


@pytest.mark.parametrize("filename,data,code", [
    pytest.param("a.csv", b"", "empty_file", id="empty_file"),
    pytest.param("a.pdf", b"%PDF", "unsupported_file", id="unsupported_file"),
    pytest.param("a.csv", b"x\n" + b"y" * (20 * 1024 * 1024 + 1), "file_too_large", id="file_too_large"),
    pytest.param("a.csv", (",".join(f"c{i}" for i in range(61)) + "\n" + ",".join("1" * 61)).encode(),
                 "too_many_columns", id="too_many_columns"),
])
def test_upload_validation(client, ws_id, filename, data, code):
    r = client.post(f"/api/workspaces/{ws_id}/dataset", files={"file": (filename, data)})
    assert r.status_code == 422 and r.json()["error"]["code"] == code
    assert client.get(f"/api/workspaces/{ws_id}/dataset").status_code == 404     # nothing was imported


def test_upload_requires_file(client, ws_id):
    r = client.post(f"/api/workspaces/{ws_id}/dataset")
    assert r.status_code == 422 and r.json()["error"]["code"] == "validation_error"
