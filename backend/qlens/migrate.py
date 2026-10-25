from pathlib import Path

import psycopg
from psycopg.rows import dict_row

MIGRATIONS_DIR = Path(__file__).resolve().parent.parent / "sql" / "migrations"

# Created here rather than only in 000_bootstrap.sql because the runner needs it to know
# whether 000_bootstrap has been applied.
_ENSURE_TRACKING = """
CREATE SCHEMA IF NOT EXISTS qlens;
CREATE TABLE IF NOT EXISTS qlens.schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
)
"""


def apply_migrations(conn: psycopg.Connection) -> list[str]:
    """Apply pending sql/migrations/*.sql in name order; return the versions applied now."""
    conn.commit()
    with conn.transaction():
        conn.execute(_ENSURE_TRACKING)
    with conn.cursor(row_factory=dict_row) as cur:
        done = {r["version"] for r in cur.execute("SELECT version FROM qlens.schema_migrations")}
    conn.commit()

    applied: list[str] = []
    for path in sorted(MIGRATIONS_DIR.glob("*.sql")):
        version = path.stem
        if version in done:
            continue
        # One transaction per file: a failing migration leaves no partial changes and no record.
        with conn.transaction():
            conn.execute(path.read_text(encoding="utf-8"))
            conn.execute("INSERT INTO qlens.schema_migrations (version) VALUES (%s)", (version,))
        applied.append(version)
    return applied


def main() -> None:
    from qlens.config import get_settings

    with psycopg.connect(get_settings().database_url) as conn:
        for v in apply_migrations(conn):
            print(f"applied {v}")


if __name__ == "__main__":
    main()
