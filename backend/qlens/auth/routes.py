from fastapi import APIRouter, Depends, Request, Response

from qlens import db
from qlens.auth import service
from qlens.auth.deps import current_user
from qlens.auth.service import LoginIn, SignupIn, UserOut
from qlens.config import get_settings

router = APIRouter(prefix="/auth", tags=["auth"])


def _set_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        service.SESSION_COOKIE, token,
        max_age=get_settings().session_days * 86400,
        httponly=True, samesite="lax", path="/",
    )


@router.post("/signup", status_code=201)
def signup(data: SignupIn, response: Response, conn: db.Conn) -> UserOut:
    user = service.signup(conn, data)
    _set_cookie(response, service.create_session(conn, user.id))
    return user


@router.post("/login")
def login(data: LoginIn, response: Response, conn: db.Conn) -> UserOut:
    user = service.authenticate(conn, data.email, data.password)
    _set_cookie(response, service.create_session(conn, user.id))
    return user


@router.post("/logout", status_code=204)
def logout(request: Request, conn: db.Conn) -> Response:
    token = request.cookies.get(service.SESSION_COOKIE)
    if token:
        service.delete_session(conn, token)
    response = Response(status_code=204)
    response.delete_cookie(service.SESSION_COOKIE, path="/", httponly=True, samesite="lax")
    return response


@router.get("/me")
def me(user: UserOut = Depends(current_user)) -> UserOut:
    return user
