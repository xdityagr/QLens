from functools import lru_cache
from pathlib import Path
from typing import Literal

from psycopg.conninfo import conninfo_to_dict
from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Anchored to this file so the app and tests find .env regardless of the working directory.
# The file is optional: in production every setting comes from real environment variables,
# which also win over .env when both are present.
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"
# The built web app (`npm run build` in frontend/). Served by the API itself when APP_ENV=production.
DEFAULT_FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    # postgres:// and postgresql:// URLs are both accepted; query parameters such as ?sslmode=require
    # are kept and reused for the workspace sandbox connections.
    database_url: str
    # Only the test suite needs this; production never sets it.
    test_database_url: str | None = None
    # Only setup_db needs superuser access, and it reads the password from .env.pgadmin instead.
    admin_database_url: str | None = None
    secret_key: str
    # Roles are cluster-wide, so tests use a different prefix ("qlenstest_ws_") from dev.
    role_prefix: str = "qlens_ws_"
    # The assistant is off when no key is set; the UI says so plainly.
    gemini_api_key: str | None = None
    gemini_model: str = "gemini-3.5-flash"   # GA, function calling; override with GEMINI_MODEL
    session_days: int = 14
    db_pool_max: int = 10

    # "production" makes the API serve the built frontend (single origin, so the session cookie is first-party).
    app_env: str = "development"
    frontend_dist: Path = DEFAULT_FRONTEND_DIST
    # Behind HTTPS (any cloud host) the session cookie should be Secure. SameSite=None needs Secure,
    # so "none" forces it on.
    cookie_secure: bool = False
    cookie_samesite: Literal["lax", "strict", "none"] = "lax"

    @field_validator("database_url", "test_database_url")
    @classmethod
    def _normalise_scheme(cls, v: str | None) -> str | None:
        # Heroku-style hosts hand out postgres://; libpq takes both, this keeps one spelling everywhere.
        if v and v.startswith("postgres://"):
            return "postgresql://" + v.removeprefix("postgres://")
        return v

    @field_validator("cookie_samesite", mode="before")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.lower() if isinstance(v, str) else v

    @property
    def is_production(self) -> bool:
        return self.app_env.strip().lower() in ("production", "prod")

    @property
    def cookie_is_secure(self) -> bool:
        return self.cookie_secure or self.cookie_samesite == "none"

    # Host, port and database of DATABASE_URL. Workspace sandbox connections go to the same place.
    @property
    def pg_host(self) -> str:
        return conninfo_to_dict(self.database_url).get("host") or "localhost"

    @property
    def pg_port(self) -> int:
        return int(conninfo_to_dict(self.database_url).get("port") or 5432)

    @property
    def pg_dbname(self) -> str:
        return conninfo_to_dict(self.database_url).get("dbname") or ""


@lru_cache
def get_settings() -> Settings:
    return Settings()
