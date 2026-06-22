from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from app.utils import ensure_dir, now_ts


class AuthStore:
    def __init__(
        self,
        path: Path,
        *,
        auth_enabled: bool = True,
        session_ttl_seconds: int = 12 * 60 * 60,
        logger: logging.Logger | None = None,
    ):
        self.path = path
        self.auth_enabled = auth_enabled
        self.session_ttl_seconds = session_ttl_seconds
        self.logger = logger or logging.getLogger('web_auto.auth')
        self.lock = threading.Lock()
        self.sessions: dict[str, dict[str, Any]] = {}

    def _load_locked(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        with self.path.open('r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}

    def _save_locked(self, data: dict[str, Any]) -> None:
        ensure_dir(self.path.parent)
        tmp = self.path.with_suffix(self.path.suffix + '.tmp')
        with tmp.open('w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write('\n')
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.path)

    @staticmethod
    def _validate_username(username: str) -> str:
        clean = str(username or '').strip()
        if len(clean) < 3 or len(clean) > 64:
            raise ValueError('username must be 3-64 characters')
        if not re.fullmatch(r'[A-Za-z0-9_.@-]+', clean):
            raise ValueError('username may only contain letters, numbers, dot, underscore, at sign, and dash')
        return clean

    @staticmethod
    def _validate_password(password: str) -> str:
        text = str(password or '')
        if len(text) < 8:
            raise ValueError('password must be at least 8 characters')
        if len(text) > 256:
            raise ValueError('password is too long')
        return text

    @staticmethod
    def _hash_password(password: str) -> str:
        salt = secrets.token_hex(16)
        iterations = 260000
        digest = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('ascii'), iterations)
        return f'pbkdf2_sha256${iterations}${salt}${digest.hex()}'

    @staticmethod
    def _verify_password(password: str, stored: str) -> bool:
        try:
            algorithm, iterations_raw, salt, digest_hex = str(stored or '').split('$', 3)
            if algorithm != 'pbkdf2_sha256':
                return False
            iterations = int(iterations_raw)
            expected = bytes.fromhex(digest_hex)
            actual = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt.encode('ascii'), iterations)
            return hmac.compare_digest(actual, expected)
        except Exception:
            return False

    @staticmethod
    def _session_key(token: str) -> str:
        return hashlib.sha256(str(token or '').encode('utf-8')).hexdigest()

    def has_admin(self) -> bool:
        with self.lock:
            data = self._load_locked()
            admin = data.get('admin')
            return isinstance(admin, dict) and bool(str(admin.get('username') or '').strip()) and bool(admin.get('password_hash'))

    def setup_admin(self, username: str, password: str) -> str:
        clean_username = self._validate_username(username)
        clean_password = self._validate_password(password)
        with self.lock:
            data = self._load_locked()
            if isinstance(data.get('admin'), dict) and data['admin'].get('password_hash'):
                raise ValueError('admin user is already initialized')
            data = {
                'version': 1,
                'admin': {
                    'username': clean_username,
                    'password_hash': self._hash_password(clean_password),
                    'created_at': now_ts(),
                    'password_changed_at': now_ts(),
                },
            }
            self._save_locked(data)
            self.sessions.clear()
        return clean_username

    def ensure_admin_from_env(self) -> str | None:
        if not self.auth_enabled or self.has_admin():
            return None
        username = os.getenv('WEB_AUTO_ADMIN_USERNAME', 'admin').strip() or 'admin'
        password = os.getenv('WEB_AUTO_ADMIN_PASSWORD', '').strip()
        if not password:
            self.logger.warning('web-auto admin is not initialized and WEB_AUTO_ADMIN_PASSWORD is empty')
            return None
        try:
            created = self.setup_admin(username, password)
            self.logger.info('initialized web-auto admin user from environment: %s', created)
            return created
        except ValueError as exc:
            self.logger.error('failed to initialize web-auto admin from environment: %s', exc)
            return None

    def verify_login(self, username: str, password: str) -> str:
        clean_username = str(username or '').strip()
        with self.lock:
            data = self._load_locked()
            admin = data.get('admin') if isinstance(data.get('admin'), dict) else {}
            stored_username = str(admin.get('username') or '').strip()
            stored_hash = str(admin.get('password_hash') or '')
            if not stored_username or not stored_hash:
                raise ValueError('admin user is not initialized')
            if clean_username != stored_username or not self._verify_password(str(password or ''), stored_hash):
                raise ValueError('invalid username or password')
            return stored_username

    def create_session(self, username: str) -> str:
        token = secrets.token_urlsafe(48)
        with self.lock:
            self.sessions[self._session_key(token)] = {
                'username': str(username),
                'expires_at': time.time() + self.session_ttl_seconds,
            }
        return token

    def validate_session(self, token: str) -> str | None:
        if not token:
            return None
        key = self._session_key(token)
        with self.lock:
            item = self.sessions.get(key)
            if not isinstance(item, dict):
                return None
            if float(item.get('expires_at') or 0.0) <= time.time():
                self.sessions.pop(key, None)
                return None
            item['expires_at'] = time.time() + self.session_ttl_seconds
            return str(item.get('username') or '').strip() or None

    def destroy_session(self, token: str) -> None:
        if not token:
            return
        with self.lock:
            self.sessions.pop(self._session_key(token), None)

    def change_password(self, username: str, current_password: str, new_password: str) -> None:
        clean_password = self._validate_password(new_password)
        with self.lock:
            data = self._load_locked()
            admin = data.get('admin') if isinstance(data.get('admin'), dict) else {}
            stored_username = str(admin.get('username') or '').strip()
            stored_hash = str(admin.get('password_hash') or '')
            if username != stored_username or not stored_hash:
                raise ValueError('admin user is not initialized')
            if not self._verify_password(str(current_password or ''), stored_hash):
                raise ValueError('current password is incorrect')
            admin['password_hash'] = self._hash_password(clean_password)
            admin['password_changed_at'] = now_ts()
            data['admin'] = admin
            self._save_locked(data)
            self.sessions.clear()
