"""Recorder permission boundary. Infrastructure is managed independently."""
from __future__ import annotations
import asyncio
import json
import logging
from .license_client import client_from_env

ENV_FILE = "/etc/ainvr-recorder/service.env"


class LicenseGuard:
    def __init__(self, client, **_obsolete):
        self._client = client
        self._last_phase = None

    def licensed(self) -> tuple[bool, str]:
        if self._client is None:  # only an explicit development profile
            return True, "development_disabled"
        phase = self._client.phase()
        if phase != self._last_phase:
            self._last_phase = phase
            snapshot = getattr(self._client, "decision_diagnostics", lambda: {"phase": phase})()
            logging.getLogger(__name__).warning("recorder permission before reconciliation: %s", json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")))
        return phase == "valid", phase

    async def interlock_loop(self) -> None:
        # Compatibility with the lifecycle registry. Never stop databases here.
        await asyncio.Future()


def build_guard(env_file: str = ENV_FILE):
    client = client_from_env("recorder", env_file=env_file)
    return client, LicenseGuard(client)
