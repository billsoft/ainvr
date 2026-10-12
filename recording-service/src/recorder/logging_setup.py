"""统一日志：stdout 输出（systemd 捕获），与 ai-service 风格一致。"""
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / 'shared'))
from ainvr_logging import configure_handler

_configured = False


def setup_logging(level: str = "INFO") -> None:
    global _configured
    if _configured:
        return
    handler = configure_handler(logging.StreamHandler(sys.stdout))
    root = logging.getLogger()
    root.setLevel(level.upper())
    root.handlers[:] = [handler]
    _configured = True


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
