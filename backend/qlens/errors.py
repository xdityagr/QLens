from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, detail: Any = None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.detail = detail


async def _handle_api_error(_: Request, exc: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"code": exc.code, "message": exc.message, "detail": exc.detail}},
    )


async def _handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
    # Keep only loc/msg: the raw errors can carry exception objects that are not JSON-serialisable.
    detail = [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]
    message = detail[0]["msg"] if detail else "Invalid request."
    return JSONResponse(
        status_code=422,
        content={"error": {"code": "validation_error", "message": message, "detail": detail}},
    )


def install_error_handlers(app: FastAPI) -> None:
    app.add_exception_handler(ApiError, _handle_api_error)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, _handle_validation_error)  # type: ignore[arg-type]
