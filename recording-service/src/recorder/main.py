"""ainvr-recorder 入口。

用法：
  python -m recorder.main --data-dir /home/sunrise/ainvr/recording-service/data
配置：
  data/config.json 控制监听地址/端口与控制台/SRS 地址；
  环境变量 RECORDER_CONFIG 可覆盖配置文件路径。
"""
from __future__ import annotations

import argparse
import os

import uvicorn

from .app import create_app
from .config import ConfigStore
from .logging_setup import setup_logging
from .internal_network import NetworkPolicy
from starlette.responses import JSONResponse


def main() -> None:
    parser = argparse.ArgumentParser(prog="ainvr-recorder")
    default_data = os.environ.get(
        "RECORDER_DATA",
        os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data")),
    )
    parser.add_argument("--data-dir", default=default_data)
    parser.add_argument("--log-level", default=os.environ.get("RECORDER_LOG", "INFO"))
    args = parser.parse_args()

    setup_logging(args.log_level)
    os.makedirs(args.data_dir, exist_ok=True)
    config_path = os.environ.get(
        "RECORDER_CONFIG", os.path.join(args.data_dir, "config.json"))
    store = ConfigStore(config_path)
    app = create_app(store, args.data_dir)
    peers = NetworkPolicy()
    @app.middleware('http')
    async def internal_peer_only(request, call_next):
        if not request.client or not peers.allows(request.client.host):
            return JSONResponse({'detail': '请通过控制台访问'}, status_code=403)
        return await call_next(request)
    cfg = store.get()
    uvicorn.run(
        app,
        host=cfg.server.host,
        port=cfg.server.port,
        log_config=None,
        access_log=False,
        proxy_headers=False,  # Peer policy must inspect the TCP peer, never X-Forwarded-For.
    )


if __name__ == "__main__":
    main()
