"""Production only: the API also serves the built web app, so the browser sees one origin.

With the page and /api on the same origin the session cookie stays first-party (SameSite=Lax works and no
CORS is needed). In development Vite serves the page and proxies /api to uvicorn instead.
"""
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.staticfiles import StaticFiles


class _HashedAssets(StaticFiles):
    """Vite puts a content hash in every file name under assets/, so they never change and can be cached for good."""

    def file_response(self, *args, **kwargs) -> Response:
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response


def mount_frontend(app: FastAPI, dist: Path) -> None:
    """Serve `dist` (frontend/dist): real files as they are, every other non-API path as index.html.

    Must be called after the API routers are included: the catch-all route only gets what they did not match.
    """
    dist = dist.resolve()
    index = dist / "index.html"
    if not index.is_file():
        raise RuntimeError(f"APP_ENV=production but {index} does not exist; run `npm run build` in frontend/")
    if (dist / "assets").is_dir():
        app.mount("/assets", _HashedAssets(directory=dist / "assets"), name="assets")

    @app.api_route("/{path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def spa(path: str) -> Response:
        if path == "api" or path.startswith("api/"):
            # An unknown API path is an API error, never the HTML page.
            return JSONResponse(status_code=404, content={
                "error": {"code": "not_found", "message": "No such API endpoint.", "detail": None}})
        if path:
            file = (dist / path).resolve()
            if file.is_relative_to(dist) and file.is_file():   # favicon.svg and the like; no escaping dist
                return FileResponse(file)
        # A client-side route such as /w/1/data: React Router reads the URL once index.html loads.
        # no-cache so a redeploy's new asset names are picked up at once.
        return FileResponse(index, headers={"Cache-Control": "no-cache"})
