from __future__ import annotations

from pydantic import BaseModel


class AuthSetupIn(BaseModel):
    username: str
    password: str


class AuthLoginIn(BaseModel):
    username: str
    password: str


class AuthPasswordChangeIn(BaseModel):
    current_password: str
    new_password: str
