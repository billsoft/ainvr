"""Authoritative console authentication; no local administrator password copy."""
from __future__ import annotations

import asyncio
import hmac
import ipaddress
import json
import os
import urllib.error
import urllib.request

from fastapi import HTTPException, Request

def service_token() -> str:
    return os.environ.get("CONFIG_SERVICE_TOKEN_RECORDER", "").strip()


def _authorize(token: str | None, cookie: str | None) -> int:
    secret = service_token()
    if not secret:
        return 503
    base = os.environ.get("CONFIG_CENTER_URL", "http://127.0.0.1:3001").rstrip("/")
    req = urllib.request.Request(base + "/internal/recorder-auth",
        data=json.dumps({"token": token, "cookie": cookie}).encode(),
        headers={"Content-Type": "application/json", "X-Service-Token": secret}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return 204 if response.status == 204 else 503
    except urllib.error.HTTPError as error:
        return 401 if error.code == 401 else 503
    except (OSError, ValueError):
        return 503


async def _require(request: Request, media: bool) -> None:
    expected = service_token()
    presented = request.headers.get("x-service-token", "")
    if expected and hmac.compare_digest(expected, presented):
        return
    token = request.headers.get("x-console-token")
    # Credentials never belong in URLs; browsers use the playback-only cookie.
    status = await asyncio.to_thread(_authorize, token, request.headers.get("cookie") if media else None)
    if status != 204:
        raise HTTPException(status_code=status,
            detail="需要登录" if status == 401 else "鉴权服务暂不可用")


async def require_console_token(request: Request) -> None:
    await _require(request, False)


async def require_media_token(request: Request) -> None:
    await _require(request, True)


def _loopback_peer(request: Request) -> bool:
    # TCP peer only (uvicorn proxy_headers=False); forwarded headers never count.
    try:
        ip = ipaddress.ip_address(request.client.host if request.client else "")
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_loopback


async def require_console_or_local_probe(request: Request) -> None:
    """Read-only health for same-host monitors; containers and LAN still need a session."""
    if _loopback_peer(request):
        return
    await _require(request, False)
