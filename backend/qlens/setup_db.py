"""One-time, idempotent database bootstrap: `uv run python -m qlens.setup_db`.

Reads the postgres superuser password from the repo-root `.env.admin` (ADMIN_PG_PASSWORD).
That password is only used for this connection; it is never printed or written anywhere.
"""
import secrets
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit

import psycopg
from psycopg import sql

BACKEND_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BACKEND_DIR / ".env"
ADMIN_ENV_FILE = BACKEND_DIR.parent / ".env.admin"

HOST, PORT = "localhost", 5433
APP_ROLE = "qlens_app"
DATABASES = ("qlens", "qlens_test")


def read_env(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                values[k.strip()] = v.strip().strip('"').strip("'")
    return values


def admin_connect(dbname: str) -> psycopg.Connection:
    password = read_env(ADMIN_ENV_FILE).get("ADMIN_PG_PASSWORD")
    if not password:
        sys.exit(f"ADMIN_PG_PASSWORD not found in {ADMIN_ENV_FILE}")
    return psycopg.connect(host=HOST, port=PORT, user="postgres", password=password,
                           dbname=dbname, autocommit=True)


def existing_app_password(env: dict[str, str]) -> str | None:
    url = env.get("DATABASE_URL")
    return urlsplit(url).password if url else None


def ensure_role(conn: psycopg.Connection, password: str, reset: bool) -> None:
    exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (APP_ROLE,)).fetchone()
    # CREATE/ALTER ROLE can't take bind parameters, so the password is inlined as a literal.
    if not exists:
        conn.execute(sql.SQL("CREATE ROLE {} LOGIN CREATEROLE PASSWORD {}").format(
            sql.Identifier(APP_ROLE), sql.Literal(password)))
    elif reset:
        conn.execute(sql.SQL("ALTER ROLE {} LOGIN CREATEROLE PASSWORD {}").format(
            sql.Identifier(APP_ROLE), sql.Literal(password)))


def ensure_database(conn: psycopg.Connection, name: str) -> None:
    if not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone():
        conn.execute(sql.SQL("CREATE DATABASE {} OWNER {}").format(
            sql.Identifier(name), sql.Identifier(APP_ROLE)))


def prepare_database(name: str) -> None:
    with admin_connect(name) as conn:
        conn.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
        conn.execute(sql.SQL("CREATE SCHEMA IF NOT EXISTS qlens AUTHORIZATION {}").format(
            sql.Identifier(APP_ROLE)))
        conn.execute("REVOKE ALL ON SCHEMA qlens FROM PUBLIC")
        # Workspace roles must not be able to create objects in public.
        conn.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")


def write_env(password: str, env: dict[str, str]) -> None:
    pw = quote(password, safe="")
    env["DATABASE_URL"] = f"postgresql://{APP_ROLE}:{pw}@{HOST}:{PORT}/qlens"
    env["TEST_DATABASE_URL"] = f"postgresql://{APP_ROLE}:{pw}@{HOST}:{PORT}/qlens_test"
    env.setdefault("SECRET_KEY", secrets.token_hex(32))
    ENV_FILE.write_text("".join(f"{k}={v}\n" for k, v in env.items()), encoding="utf-8")


def main() -> None:
    env = read_env(ENV_FILE)
    known_password = existing_app_password(env)
    password = known_password or secrets.token_urlsafe(24)

    with admin_connect("postgres") as conn:
        # Role exists but .env doesn't know its password: reset it so the app can log in.
        ensure_role(conn, password, reset=known_password is None)
        for name in DATABASES:
            ensure_database(conn, name)
    for name in DATABASES:
        prepare_database(name)
    write_env(password, env)
    print(f"Role {APP_ROLE} and databases {', '.join(DATABASES)} are ready; wrote {ENV_FILE.name}.")


if __name__ == "__main__":
    main()
