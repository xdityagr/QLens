import hashlib
import re
import secrets

import psycopg
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from pydantic import BaseModel, Field, field_validator

from qlens.config import get_settings
from qlens.errors import ApiError

SESSION_COOKIE = "qlens_session"
_hasher = PasswordHasher()
# Verified against when the email is unknown, so login timing does not reveal which emails exist.
_DUMMY_HASH = _hasher.hash("qlens-dummy-password")
_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class UserOut(BaseModel):
    id: int
    email: str
    display_name: str


class SignupIn(BaseModel):
    email: str
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=80)

    @field_validator("email")
    @classmethod
    def _email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Enter a valid email address.")
        return v

    @field_validator("display_name")
    @classmethod
    def _strip_name(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("Display name is required.")
        return v


class LoginIn(BaseModel):
    email: str
    password: str = Field(min_length=1, max_length=128)

    @field_validator("email")
    @classmethod
    def _lower(cls, v: str) -> str:
        return v.strip().lower()


def hash_token(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


def signup(conn: psycopg.Connection, data: SignupIn) -> UserOut:
    row = conn.execute(
        "INSERT INTO qlens.users (email, password_hash, display_name) VALUES (%s, %s, %s) "
        "ON CONFLICT (email) DO NOTHING RETURNING id, email, display_name",
        (data.email, _hasher.hash(data.password), data.display_name),
    ).fetchone()
    if row is None:
        raise ApiError(409, "email_taken", "An account with this email already exists.")
    return UserOut(**row)


def authenticate(conn: psycopg.Connection, email: str, password: str) -> UserOut:
    row = conn.execute(
        "SELECT id, email, display_name, password_hash FROM qlens.users WHERE email = %s", (email,)
    ).fetchone()
    stored = row["password_hash"] if row else _DUMMY_HASH
    try:
        ok = _hasher.verify(stored, password)
    except (VerificationError, InvalidHashError):
        ok = False
    if not ok or row is None:
        raise ApiError(401, "invalid_credentials", "Wrong email or password.")
    if _hasher.check_needs_rehash(stored):
        conn.execute("UPDATE qlens.users SET password_hash = %s WHERE id = %s", (_hasher.hash(password), row["id"]))
    return UserOut(id=row["id"], email=row["email"], display_name=row["display_name"])


def create_session(conn: psycopg.Connection, user_id: int) -> str:
    token = secrets.token_urlsafe(32)
    # Opportunistic cleanup keeps the table small without a background job.
    conn.execute("DELETE FROM qlens.sessions WHERE user_id = %s AND expires_at <= now()", (user_id,))
    conn.execute(
        "INSERT INTO qlens.sessions (token_hash, user_id, expires_at) "
        "VALUES (%s, %s, now() + make_interval(days => %s))",
        (hash_token(token), user_id, get_settings().session_days),
    )
    return token


def user_for_token(conn: psycopg.Connection, token: str) -> UserOut | None:
    row = conn.execute(
        "SELECT u.id, u.email, u.display_name FROM qlens.sessions s JOIN qlens.users u ON u.id = s.user_id "
        "WHERE s.token_hash = %s AND s.expires_at > now()",
        (hash_token(token),),
    ).fetchone()
    return UserOut(**row) if row else None


def delete_session(conn: psycopg.Connection, token: str) -> None:
    conn.execute("DELETE FROM qlens.sessions WHERE token_hash = %s", (hash_token(token),))
