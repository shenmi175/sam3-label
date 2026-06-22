from __future__ import annotations

import os

from fastapi import Request
from fastapi.responses import Response

from app.services.auth_service import AuthStore


class AuthHttp:
    def __init__(
        self,
        auth_store: AuthStore,
        *,
        auth_enabled: bool,
        cookie_name: str,
        session_ttl_seconds: int,
    ):
        self.auth_store = auth_store
        self.auth_enabled = auth_enabled
        self.cookie_name = cookie_name
        self.session_ttl_seconds = session_ttl_seconds

    @staticmethod
    def public_path(path: str) -> bool:
        if path in {'/login', '/logout', '/api/health'}:
            return True
        return path.startswith('/api/auth/') and path != '/api/auth/setup'

    @staticmethod
    def page_html(mode: str) -> str:
        is_setup = mode == 'setup'
        title = 'Initialize web-auto admin' if is_setup else 'Sign in to web-auto'
        button = 'Create administrator' if is_setup else 'Sign in'
        endpoint = '/api/auth/setup' if is_setup else '/api/auth/login'
        extra = ''
        username_autocomplete = 'username'
        password_autocomplete = 'new-password' if is_setup else 'current-password'
        html = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>__TITLE__</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #eef2f6;
      color: #243042;
    }
    main {
      width: min(420px, calc(100vw - 32px));
      background: #fff;
      border: 1px solid #d8e0ea;
      border-radius: 8px;
      box-shadow: 0 18px 50px rgba(23, 37, 54, 0.16);
      padding: 28px;
    }
    h1 { margin: 0 0 6px; font-size: 24px; }
    p { margin: 0 0 24px; color: #657287; font-size: 14px; line-height: 1.5; }
    label { display: block; margin: 14px 0 7px; font-weight: 650; font-size: 13px; }
    input {
      width: 100%;
      box-sizing: border-box;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      padding: 11px 12px;
      font-size: 15px;
      outline: none;
    }
    input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14); }
    button {
      margin-top: 22px;
      width: 100%;
      border: 0;
      border-radius: 6px;
      padding: 12px 14px;
      font-weight: 700;
      font-size: 15px;
      color: #fff;
      background: #2563eb;
      cursor: pointer;
    }
    button:disabled { opacity: 0.7; cursor: wait; }
    .error { display: none; margin-top: 14px; color: #b91c1c; font-size: 13px; line-height: 1.4; }
    .link { display: inline-block; margin-top: 16px; color: #2563eb; font-size: 13px; text-decoration: none; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #e5e7eb; }
      main { background: #1f2937; border-color: #374151; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35); }
      p { color: #a7b0c0; }
      input { background: #111827; color: #e5e7eb; border-color: #4b5563; }
    }
  </style>
</head>
<body>
  <main>
    <h1>__TITLE__</h1>
    <p>Use this account to access the web-auto workspace and API.</p>
    <form id="auth-form">
      <label for="username">Username</label>
      <input id="username" name="username" autocomplete="__USERNAME_AUTOCOMPLETE__" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="__PASSWORD_AUTOCOMPLETE__" required>
      <button id="submit" type="submit">__BUTTON__</button>
      <div id="error" class="error"></div>
      __EXTRA__
    </form>
  </main>
  <script>
    const form = document.getElementById('auth-form');
    const errorBox = document.getElementById('error');
    const submit = document.getElementById('submit');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox.style.display = 'none';
      submit.disabled = true;
      try {
        const response = await fetch('__ENDPOINT__', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            username: document.getElementById('username').value,
            password: document.getElementById('password').value
          })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.detail || response.statusText);
        window.location.href = '/';
      } catch (err) {
        errorBox.textContent = err.message || String(err);
        errorBox.style.display = 'block';
      } finally {
        submit.disabled = false;
      }
    });
  </script>
</body>
</html>
"""
        return (
            html.replace('__TITLE__', title)
            .replace('__BUTTON__', button)
            .replace('__ENDPOINT__', endpoint)
            .replace('__EXTRA__', extra)
            .replace('__USERNAME_AUTOCOMPLETE__', username_autocomplete)
            .replace('__PASSWORD_AUTOCOMPLETE__', password_autocomplete)
        )

    @staticmethod
    def _secure_cookie_for_request(request: Request) -> bool:
        raw = os.getenv('WEB_AUTO_SESSION_COOKIE_SECURE', 'auto').strip().lower()
        if raw in {'1', 'true', 'yes', 'on'}:
            return True
        if raw in {'0', 'false', 'no', 'off'}:
            return False
        proto = str(request.headers.get('x-forwarded-proto') or request.url.scheme or '').split(',')[0].strip().lower()
        return proto == 'https'

    def set_session_cookie(self, response: Response, request: Request, token: str) -> None:
        response.set_cookie(
            key=self.cookie_name,
            value=token,
            max_age=self.session_ttl_seconds,
            httponly=True,
            secure=self._secure_cookie_for_request(request),
            samesite='lax',
            path='/',
        )

    def clear_session_cookie(self, response: Response, request: Request) -> None:
        response.delete_cookie(
            key=self.cookie_name,
            path='/',
            secure=self._secure_cookie_for_request(request),
            httponly=True,
            samesite='lax',
        )

    def request_username(self, request: Request) -> str | None:
        if not self.auth_enabled:
            return 'auth-disabled'
        return self.auth_store.validate_session(str(request.cookies.get(self.cookie_name) or ''))
