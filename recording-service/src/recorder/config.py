"""配置模型与持久化。

data/config.json 结构（0600）：
  server/console/srs_api_url 为部署级配置；
  recording 子树即前端 RecorderConfig，字段与
  srs-web-console/frontend/src/types/recording.ts 一一对应。
SMB 密码只存本文件，任何响应永不回显明文。
"""
from __future__ import annotations

import json
import os
import threading
from typing import Literal

from pydantic import BaseModel, Field, field_validator

StorageKind = Literal["local", "smb"]
QuotaMode = Literal["percent", "gb"]
QuotaOnFull = Literal["overwrite", "stop"]
SmbVersion = Literal["auto", "3.0", "2.1"]

DEFAULT_LOCAL_PATH = "/home/sunrise/ainvr/data/recordings"
DEFAULT_MOUNT_POINT = "/mnt/ainvr-recorder"


class SmbConfig(BaseModel):
    host: str = ""
    share: str = ""
    path: str = ""
    username: str = ""
    # 仅持久化/入参使用；API 响应前必须 model_dump 时排除
    password: str = ""
    smbVersion: SmbVersion = "auto"
    domain: str | None = None

    def public(self) -> dict:
        """前端可见形态：passwordSet 布尔，绝不明文回显。"""
        return {
            "host": self.host,
            "share": self.share,
            "path": self.path,
            "username": self.username,
            "passwordSet": bool(self.password),
            "smbVersion": self.smbVersion,
            "domain": self.domain,
        }


class StorageConfig(BaseModel):
    kind: StorageKind = "local"
    localPath: str = DEFAULT_LOCAL_PATH
    smb: SmbConfig | None = None


class QuotaConfig(BaseModel):
    mode: QuotaMode = "percent"
    percent: int = Field(default=90, ge=50, le=99)
    gb: int | None = Field(default=None, gt=0)
    onFull: QuotaOnFull = "overwrite"
    minRetentionDays: int | None = Field(default=None, gt=0)


class FilesConfig(BaseModel):
    # 默认 60s；切点对齐关键帧，实际时长允许波动
    segmentSeconds: int = Field(default=60, ge=10, le=3600)


class ChannelSchedule(BaseModel):
    """单通道录像计划：是否录像 + 24 小时整点时间表（0-23，默认全选）。

    语义（2026-09-18 通道选择对话框引入）：
    - enabled=False 优先于 hours（勾选关闭=全天不录）；
    - hours 为 0-23 的子集，空列表=不录（对话框会在启用时兜底全选）；
    - 判定用本地时区当前小时：wanted = enabled and (now.hour in hours)。
    """

    enabled: bool = True
    hours: list[int] = Field(default_factory=lambda: list(range(24)))

    @field_validator("hours", mode="before")
    @classmethod
    def _validate_hours(cls, v: list[int]) -> list[int]:
        if not isinstance(v, list):
            raise ValueError("hours 必须为整点列表")
        bad = [h for h in v if type(h) is not int or not 0 <= h <= 23]
        if bad:
            raise ValueError(f"hours 必须为 0-23 的整数，非法值: {bad}")
        return sorted(set(v))

    def is_recording_at(self, hour: int) -> bool:
        return self.enabled and hour in self.hours

    def public(self) -> dict:
        return {"enabled": self.enabled, "hours": self.hours}


class RecorderConfig(BaseModel):
    storage: StorageConfig = Field(default_factory=StorageConfig)
    quota: QuotaConfig = Field(default_factory=QuotaConfig)
    files: FilesConfig = Field(default_factory=FilesConfig)


class ConsoleConfig(BaseModel):
    # srs-web-console 入口（nginx :80）；同步通道目录用
    base_url: str = "http://127.0.0.1"
    # Legacy field accepted for migration only; never used for authentication.
    token: str = ""


class ServerConfig(BaseModel):
    # 绑定全部网卡：backend/frontend 容器经 host.docker.internal（docker0 网桥
    # IP）回连宿主机，绑 127.0.0.1 容器不可达（与 ai-service :8000 同模式）。
    # 访问控制靠 X-Console-Token；媒体走 query token。
    host: str = "0.0.0.0"
    port: int = 8100


class ServiceConfig(BaseModel):
    server: ServerConfig = Field(default_factory=ServerConfig)
    console: ConsoleConfig = Field(default_factory=ConsoleConfig)
    srs_api_url: str = "http://127.0.0.1:1985"
    enabled_channel_ids: list[str] = Field(default_factory=list)
    # 通道录像计划（2026-09-18）：channelId → ChannelSchedule。
    # 与 enabled_channel_ids 的关系：channel_schedules 为唯一规范；
    # enabled_channel_ids 仅作旧配置（无 schedule 时）的只读兼容输入，
    # 由 BFF 写入时显式迁移，recorder 端不并行维护两份可写状态。
    channel_schedules: dict[str, ChannelSchedule] = Field(default_factory=dict)
    recording: RecorderConfig = Field(default_factory=RecorderConfig)


class ConfigStore:
    """JSON 文件配置，线程安全，写盘原子化（tmp+rename），0600。"""

    def __init__(self, path: str):
        self.path = path
        self._lock = threading.RLock()
        self.cfg = ServiceConfig()
        self._load()

    def _load(self) -> None:
        if os.path.exists(self.path):
            with open(self.path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            self.cfg = ServiceConfig.model_validate(raw)

    def save(self) -> None:
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        tmp = f"{self.path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self.cfg.model_dump(), f, ensure_ascii=False, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def get(self) -> ServiceConfig:
        with self._lock:
            return self.cfg.model_copy(deep=True)

    def mutate(self) -> ServiceConfig:
        """加锁拿可变引用；改完必须 commit()。仅单进程内使用。"""
        self._lock.acquire()
        return self.cfg

    def commit(self) -> None:
        try:
            self.save()
        finally:
            self._lock.release()
