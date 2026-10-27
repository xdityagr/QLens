# QLens production image: one container serves the API and the built web app on $PORT.
# Build:  docker build -t qlens .
# Run:    docker run -p 8000:8000 -e DATABASE_URL=... -e SECRET_KEY=... qlens

# ---- 1. web app -----------------------------------------------------------------------------------
FROM node:24-slim AS web
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- 2. API ---------------------------------------------------------------------------------------
FROM python:3.13-slim AS app
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /app/backend
# Dependencies first, so code changes do not reinstall them. The qlens package itself runs from the
# working directory and is not installed.
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY backend/qlens ./qlens
COPY backend/sql ./sql
COPY --from=web /app/frontend/dist /app/frontend/dist

RUN useradd --system --uid 10001 --home-dir /app qlens
USER qlens
ENV PATH="/app/.venv/bin:$PATH" \
    APP_ENV=production \
    PORT=8000
EXPOSE 8000
# cloud_init is idempotent: it checks CREATEROLE, prepares the schema and applies pending migrations.
# Render (and most hosts) terminate TLS in front of the container, hence the proxy headers.
CMD ["sh", "-c", "python -m qlens.cloud_init && exec uvicorn qlens.main:app --host 0.0.0.0 --port \"$PORT\" --proxy-headers --forwarded-allow-ips='*'"]
