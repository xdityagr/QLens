"""Bootstrap a managed (cloud) PostgreSQL database: `python -m qlens.cloud_init`.

The cloud counterpart of setup_db + migrate. It needs only DATABASE_URL, for a user that owns the database
(the default user of Render Postgres, Neon and similar). No superuser, no .env file. Idempotent, so the
container runs it before every start.

Steps: check the user may create roles (every workspace gets its own LOGIN role); create pg_trgm; create the
qlens schema and keep PUBLIC out of it; stop PUBLIC creating objects in public; apply pending migrations.
"""
import sys

import psycopg
from psycopg.rows import dict_row

from qlens.config import get_settings
from qlens.migrate import apply_migrations

CREATEROLE_HELP = """\
The database user {user!r} cannot create roles (rolcreaterole is false).
QLens creates one LOGIN role per workspace and runs that workspace's SQL as it, so it needs CREATEROLE.
Check with:   SELECT rolcreaterole FROM pg_roles WHERE rolname = current_user;
Fix: grant it as an admin (ALTER ROLE {user} CREATEROLE;) or use a provider whose default user has it
(Neon does). See DEPLOY.md."""


def _warn(msg: str) -> None:
    print(f"cloud_init: warning: {msg}", file=sys.stderr)


def check_createrole(conn: psycopg.Connection) -> None:
    row = conn.execute("SELECT current_user AS u, rolcreaterole OR rolsuper AS ok "
                       "FROM pg_roles WHERE rolname = current_user").fetchone()
    if not row["ok"]:
        sys.exit("cloud_init: error: " + CREATEROLE_HELP.format(user=row["u"]))


def prepare(conn: psycopg.Connection) -> None:
    """The one-off DDL setup_db does as superuser for the local cluster, done here as the database owner."""
    try:
        conn.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    except psycopg.Error as e:
        # pg_trgm is a trusted extension (PG13+), so a database owner may create it.
        sys.exit(f"cloud_init: error: could not create extension pg_trgm: {e.diag.message_primary or e}")
    conn.execute("CREATE SCHEMA IF NOT EXISTS qlens")
    conn.execute("REVOKE ALL ON SCHEMA qlens FROM PUBLIC")
    try:
        # Workspace roles must not be able to create objects in public. PG15+ already defaults to this;
        # on older servers only the schema owner may revoke it.
        conn.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
    except psycopg.Error as e:
        _warn(f"could not revoke CREATE on schema public from PUBLIC ({e.diag.message_primary or e}); "
              "on PostgreSQL 14 or older workspace roles could then create tables in public")


def main() -> None:
    url = get_settings().database_url
    with psycopg.connect(url, autocommit=True, row_factory=dict_row) as conn:
        check_createrole(conn)
        prepare(conn)
    with psycopg.connect(url) as conn:
        # Two containers starting together (a deploy overlapping a restart) must not both migrate.
        # A session lock survives the per-migration commits; it is released when the connection closes.
        conn.execute("SELECT pg_advisory_lock(hashtext('qlens.cloud_init'))")
        conn.commit()
        applied = apply_migrations(conn)
    print(f"cloud_init: database ready ({len(applied)} migration(s) applied: {', '.join(applied) or 'none pending'})")


if __name__ == "__main__":
    main()
