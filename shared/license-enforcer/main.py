#!/usr/bin/env python3
"""Independent SRS enforcement. PostgreSQL, MongoDB and management stay up."""
from __future__ import annotations
import logging
import json
from pathlib import Path
import signal
import subprocess
import sys
import threading
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python"))
from license_client import client_from_env

STOP = threading.Event()
BUSINESS_CONTAINER = "ainvr-srs"
# Unknown permission never starts or stops a container. Initial business startup
# still requires verified permission in the AI/recorder clients.
STOP_MARKER = Path("/var/lib/ainvr-license-enforcer/stopped-srs")
START_MARKER = Path("/var/lib/ainvr-license-enforcer/start-pending")


def clear_start_intent():
    STOP_MARKER.unlink(missing_ok=True)
    START_MARKER.unlink(missing_ok=True)


def desired_state(phase: str):
    """True=verified permission; False=revoked/expired; None=unknown.
    Unknown never causes lifecycle actions; valid only resumes an owned stop.
    """
    if phase == "valid":
        return True
    if phase in ("invalid", "dormant"):
        return False
    return None


def reconcile(allowed, run=subprocess.run, diagnostics=None, allowed_now=None,
              resume_allowed=False, on_stopping=None, on_started=None) -> bool:
    if allowed is None or (allowed is True and not resume_allowed):
        return True
    try:
        result = run(["/usr/bin/docker", "inspect", "-f", "{{.State.Running}}", BUSINESS_CONTAINER],
                     capture_output=True, text=True, timeout=3, check=False)
        if result.returncode:
            return False
        running = result.stdout.strip() == "true"
        if allowed_now is not None:
            allowed = allowed_now()  # Avoid acting on a decision from before docker inspect.
            if allowed is None or (allowed is True and not resume_allowed):
                return True
        if running == allowed:
            if allowed and on_started:
                on_started()
            return True
        action = "start" if allowed else "stop"
        if action == "stop" and on_stopping:
            on_stopping()  # Record ownership before the action, including retries.
        logging.warning("SRS permission action before %s: %s", action,
                        json.dumps(diagnostics() if diagnostics else {"allowed": allowed}, ensure_ascii=False, separators=(",", ":")))
        args = ["/usr/bin/docker", "start", BUSINESS_CONTAINER] if allowed else [
            "/usr/bin/docker", "stop", "-t", "5", BUSINESS_CONTAINER]
        result = run(args, capture_output=True, text=True, timeout=10, check=False)
        logging.warning("SRS permission action result: action=%s returncode=%s", action, result.returncode)
        if result.returncode == 0 and action == "start" and on_started:
            on_started()
        return result.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def main() -> None:
    logging.basicConfig(level=logging.INFO)
    client = client_from_env("enforcer", "/etc/ainvr-license/enforcer.env")
    if client is None:
        raise RuntimeError("production enforcer cannot disable licensing")
    signal.signal(signal.SIGTERM, lambda *_: STOP.set())
    signal.signal(signal.SIGINT, lambda *_: STOP.set())
    client.start()
    try:
        while not STOP.is_set():
            # No circuit breaker may suppress revocation. Failed operations are
            # retried on each bounded iteration, including manual restarts.
            if not reconcile(desired_state(client.phase()),
                             diagnostics=client.decision_diagnostics,
                             allowed_now=lambda: desired_state(client.phase()),
                             resume_allowed=STOP_MARKER.exists() or START_MARKER.exists(),
                             on_stopping=lambda: STOP_MARKER.write_text("stopped-by-license\n"),
                             on_started=clear_start_intent):
                logging.warning("SRS permission reconciliation will retry")
            STOP.wait(1)
    finally:
        client.stop()


if __name__ == "__main__":
    main()
