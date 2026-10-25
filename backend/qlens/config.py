from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit

from pydantic_settings import BaseSettings, SettingsConfigDict

# Anchored to this file so the app and tests find .env regardless of the working directory.
ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ENV_FILE, env_file_encoding="utf-8", extra="ignore")

    database_url: str
    test_database_url: str
    # Only setup_db needs superuser access, and it reads the password from .env.admin instead.
    admin_database_url: str | None = None
    secret_key: str
    # Roles are cluster-wide, so tests use a different prefix ("qlenstest_ws_") from dev.
    role_prefix: str = "qlens_ws_"
    anthropic_api_key: str | None = None
    claude_model: str = "claude-sonnet-5-5"
    session_days: int = 14
    pg_host: str = "localhost"
    pg_port: int = 5433

    @property
    def pg_dbname(self) -> str:
        return urlsplit(self.database_url).path.lstrip("/")


@lru_cache
def get_settings() -> Settings:
    return Settings()
