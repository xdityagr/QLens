"""Private PostgreSQL cluster for this project: `uv run python -m qlens.pg_local init|start|stop|status`.

The data directory lives in backend/.pgdata (git-ignored) and listens on localhost:5544, so it never
touches any system-wide PostgreSQL. The generated superuser password goes to backend/.env.pgadmin
and is never printed.
"""
import os
import secrets
import subprocess
import sys
import tempfile
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / ".pgdata"
ADMIN_ENV_FILE = BACKEND_DIR / ".env.pgadmin"
LOG_FILE = DATA_DIR / "server.log"
PORT = 5544
PG_BIN = Path(os.environ.get("PG_BIN", "C:/Program Files/PostgreSQL/18/bin"))


def _exe(name: str) -> str:
    return str(PG_BIN / name)


def _run(args: list[str]) -> subprocess.CompletedProcess:
    # The server inherits these handles, so none may be a pipe: with stderr=PIPE the caller would
    # block until the server exits. stderr goes to a file and is read back for error messages.
    with tempfile.TemporaryFile("w+", encoding="utf-8", errors="replace") as err:
        r = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=err)
        err.seek(0)
        r.stderr = err.read()
    return r


def is_running() -> bool:
    return _run([_exe("pg_ctl"), "-D", str(DATA_DIR), "status"]).returncode == 0


def init() -> None:
    if DATA_DIR.exists():
        if not ADMIN_ENV_FILE.exists():
            sys.exit(f"{DATA_DIR} exists but {ADMIN_ENV_FILE.name} is missing; delete .pgdata to re-initialise.")
        return
    password = secrets.token_urlsafe(24)
    ADMIN_ENV_FILE.write_text(f"ADMIN_PG_PASSWORD={password}\n", encoding="utf-8")
    fd, pwfile = tempfile.mkstemp(prefix="pgpw_")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(password)
        r = _run([_exe("initdb"), "-D", str(DATA_DIR), "-U", "postgres", "-E", "UTF8", "--locale=C",
                  "--auth-local=scram-sha-256", "--auth-host=scram-sha-256", f"--pwfile={pwfile}"])
    finally:
        os.remove(pwfile)
    if r.returncode != 0:
        sys.exit(f"initdb failed:\n{r.stderr}")
    # Later settings override earlier ones in postgresql.conf, so appending is enough.
    with open(DATA_DIR / "postgresql.conf", "a", encoding="utf-8") as f:
        f.write(f"\n# qlens\nport = {PORT}\nlisten_addresses = 'localhost'\n")


def start() -> None:
    init()
    if is_running():
        print(f"already running on localhost:{PORT}")
        return
    r = _run([_exe("pg_ctl"), "-D", str(DATA_DIR), "-l", str(LOG_FILE), "-w", "start"])
    if r.returncode != 0:
        sys.exit(f"pg_ctl start failed:\n{r.stderr}\nsee {LOG_FILE}")
    print(f"started on localhost:{PORT}")


def stop() -> None:
    if not DATA_DIR.exists() or not is_running():
        print("not running")
        return
    r = _run([_exe("pg_ctl"), "-D", str(DATA_DIR), "-m", "fast", "-w", "stop"])
    if r.returncode != 0:
        sys.exit(f"pg_ctl stop failed:\n{r.stderr}")
    print("stopped")


def status() -> None:
    if DATA_DIR.exists() and is_running():
        print(f"running on localhost:{PORT}")
    else:
        print("not running")
        sys.exit(3)


COMMANDS = {"init": init, "start": start, "stop": stop, "status": status}

if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in COMMANDS:
        sys.exit("usage: python -m qlens.pg_local init|start|stop|status")
    COMMANDS[sys.argv[1]]()
