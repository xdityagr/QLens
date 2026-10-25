import hashlib

SIGNUP = {"email": "riya@x.com", "password": "correct horse", "display_name": "Riya"}


def test_signup_login_me_logout(client):
    r = client.post("/api/auth/signup", json=SIGNUP)
    assert r.status_code == 201
    user = r.json()
    assert set(user) == {"id", "email", "display_name"}
    assert user["email"] == "riya@x.com" and user["display_name"] == "Riya"
    assert client.get("/api/auth/me").json() == user

    assert client.post("/api/auth/logout").status_code == 204
    r = client.get("/api/auth/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "not_authenticated"

    r = client.post("/api/auth/login", json={"email": "riya@x.com", "password": "correct horse"})
    assert r.status_code == 200 and r.json() == user
    assert client.get("/api/auth/me").status_code == 200


def test_email_normalized_and_unique(client, conn):
    r = client.post("/api/auth/signup", json={**SIGNUP, "email": "  Riya@X.com "})
    assert r.status_code == 201 and r.json()["email"] == "riya@x.com"
    assert conn.execute("SELECT email FROM qlens.users").fetchall() == [{"email": "riya@x.com"}]

    r = client.post("/api/auth/signup", json={**SIGNUP, "email": "RIYA@x.COM"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "email_taken"
    # login is case-insensitive too
    r = client.post("/api/auth/login", json={"email": "RIYA@X.com", "password": SIGNUP["password"]})
    assert r.status_code == 200


def test_wrong_password_and_unknown_email_401(client):
    client.post("/api/auth/signup", json=SIGNUP)
    client.post("/api/auth/logout")
    for body in (
        {"email": "riya@x.com", "password": "wrong password"},
        {"email": "nobody@x.com", "password": "correct horse"},
    ):
        r = client.post("/api/auth/login", json=body)
        assert r.status_code == 401
        assert r.json()["error"]["code"] == "invalid_credentials"
    assert client.get("/api/auth/me").status_code == 401


def test_signup_validation_is_422_with_error_envelope(client):
    for bad in (
        {**SIGNUP, "password": "short"},
        {**SIGNUP, "password": "x" * 129},
        {**SIGNUP, "email": "not-an-email"},
        {**SIGNUP, "display_name": "   "},
    ):
        r = client.post("/api/auth/signup", json=bad)
        assert r.status_code == 422, bad
        assert r.json()["error"]["code"] == "validation_error"


def test_session_cookie_and_storage(client, conn):
    r = client.post("/api/auth/signup", json=SIGNUP)
    cookie = r.headers["set-cookie"].lower()
    assert "qlens_session=" in cookie and "httponly" in cookie and "samesite=lax" in cookie
    assert f"max-age={14 * 86400}" in cookie
    token = client.cookies.get("qlens_session")
    assert len(token) >= 43  # 32 bytes urlsafe base64
    row = conn.execute("SELECT token_hash FROM qlens.sessions").fetchone()
    assert bytes(row["token_hash"]) == hashlib.sha256(token.encode()).digest()
    pw = conn.execute("SELECT password_hash FROM qlens.users").fetchone()["password_hash"]
    assert pw.startswith("$argon2") and SIGNUP["password"] not in pw


def test_logout_deletes_session_row(client, conn):
    client.post("/api/auth/signup", json=SIGNUP)
    assert conn.execute("SELECT count(*) AS n FROM qlens.sessions").fetchone()["n"] == 1
    client.post("/api/auth/logout")
    assert conn.execute("SELECT count(*) AS n FROM qlens.sessions").fetchone()["n"] == 0


def test_expired_session_rejected(client, conn):
    client.post("/api/auth/signup", json=SIGNUP)
    conn.execute("UPDATE qlens.sessions SET created_at = now() - interval '2 days', "
                 "expires_at = now() - interval '1 day'")
    conn.commit()
    assert client.get("/api/auth/me").status_code == 401


def test_logout_without_session_is_204(client):
    assert client.post("/api/auth/logout").status_code == 204
