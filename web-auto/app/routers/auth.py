from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse, Response

from app.schemas import AuthLoginIn, AuthPasswordChangeIn, AuthSetupIn
from app.services.auth_http import AuthHttp


def create_auth_router(auth_http: AuthHttp) -> APIRouter:
    router = APIRouter()

    @router.get('/setup', response_class=HTMLResponse)
    def setup_page(request: Request) -> Response:
        del request
        return RedirectResponse('/login', status_code=303)

    @router.get('/login', response_class=HTMLResponse)
    def login_page(request: Request) -> Response:
        if not auth_http.auth_enabled:
            return RedirectResponse('/', status_code=303)
        auth_http.auth_store.ensure_admin_from_env()
        if auth_http.request_username(request):
            return RedirectResponse('/', status_code=303)
        return HTMLResponse(auth_http.page_html('login'))

    @router.get('/logout')
    def logout_page(request: Request) -> Response:
        token = str(request.cookies.get(auth_http.cookie_name) or '')
        auth_http.auth_store.destroy_session(token)
        response = RedirectResponse('/login', status_code=303)
        auth_http.clear_session_cookie(response, request)
        return response

    @router.get('/api/auth/status')
    def auth_status(request: Request) -> dict[str, Any]:
        username = auth_http.request_username(request)
        return {
            'enabled': auth_http.auth_enabled,
            'admin_configured': (not auth_http.auth_enabled) or auth_http.auth_store.has_admin(),
            'authenticated': bool(username),
            'username': username or '',
            'session_ttl_seconds': auth_http.session_ttl_seconds,
        }

    @router.post('/api/auth/setup')
    def auth_setup(payload: AuthSetupIn, request: Request) -> Response:
        del payload, request
        raise HTTPException(status_code=404, detail='interactive setup is disabled; use deployment admin credentials')

    @router.post('/api/auth/login')
    def auth_login(payload: AuthLoginIn, request: Request) -> Response:
        if not auth_http.auth_enabled:
            return JSONResponse({'ok': True, 'enabled': False})
        try:
            username = auth_http.auth_store.verify_login(payload.username, payload.password)
            token = auth_http.auth_store.create_session(username)
            response = JSONResponse({'ok': True, 'username': username})
            auth_http.set_session_cookie(response, request, token)
            return response
        except ValueError as exc:
            raise HTTPException(status_code=401, detail=str(exc)) from exc

    @router.post('/api/auth/logout')
    def auth_logout(request: Request) -> Response:
        token = str(request.cookies.get(auth_http.cookie_name) or '')
        auth_http.auth_store.destroy_session(token)
        response = JSONResponse({'ok': True})
        auth_http.clear_session_cookie(response, request)
        return response

    @router.post('/api/auth/password')
    def auth_change_password(payload: AuthPasswordChangeIn, request: Request) -> Response:
        username = auth_http.request_username(request)
        if not username:
            raise HTTPException(status_code=401, detail='login required')
        try:
            auth_http.auth_store.change_password(username, payload.current_password, payload.new_password)
            response = JSONResponse({'ok': True})
            auth_http.clear_session_cookie(response, request)
            return response
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    return router
