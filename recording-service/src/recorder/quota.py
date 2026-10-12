"""容量配额：percent 限额按探活刷新的容量缓存解析；超限 LRU 整段删除或停录。

enforce() 为 async：本机删除走有界维护车道，超时不判定写入故障；NAS 删除
走 IsolatedIO，超时保持熔断和重挂保护。绝不在 asyncio 事件循环
上直跑文件调用。percent 模式只读 StorageManager 的容量缓存（statvfs 也可能
在卡死 NAS 上 D 住），缓存缺失/过期时本轮直接跳过——宁可少清理一轮，绝不拿
未知容量误判 onFull=stop。
"""
from __future__ import annotations

import os
import time
from typing import TYPE_CHECKING

from .index import SegmentIndex
from .logging_setup import get_logger
from .storage import StorageManager
from .storage_io import MaintenanceBusy, StorageIOError
from .playback_protection import PlaybackProtection
from .writer_protection import is_writing

if TYPE_CHECKING:
    from .config import ConfigStore

log = get_logger("recorder.quota")

# 超限删除的迟滞：删到使用率回落到 HIGH_WATER/limit 之下即停
HIGH_WATER = 0.95
MIN_AGE_MS_FOR_DELETE = 60_000  # 绝不删除 1 分钟内的段（保护正在写的文件）
# 单个 unlink 的独立超时：健康 SMB 上删除是亚秒级，20s 只用来兜卡死。
# 一旦超时即熔断（车道上后续调用立刻快速失败），不会再出现"一个卡死文件
# 把整条数据车道堵满 120s"的情况（2026-09-18 生产现场实测）。
UNLINK_TIMEOUT_SEC = 20
# 毒文件退避：某个文件的 unlink 触发熔断后，它大概率是 NAS 服务端会话/锁
# 异常（本机无持有者、重挂后仍卡）。立刻重试只会"自愈→续录一分钟→同一
# 文件再卡死→再熔断"空转。拉黑一段时间，先保录像连续；到期再试，仍卡就
# 再退避；物理/索引一致性始终由 scanner 对账，不会丢账。
POISON_BACKOFF_SEC = 1800
QUOTA_MESSAGE_PREFIX = "配额暂停："


class QuotaEnforcer:
    def __init__(self, store: "ConfigStore", index: SegmentIndex,
                 storage_mgr: StorageManager, playback: PlaybackProtection | None = None):
        self.store = store
        self.index = index
        self.storage = storage_mgr
        self.playback = playback or PlaybackProtection()
        # abs_path -> 退避到期 monotonic 时间戳（毒文件名单，仅内存）
        self._poison: dict[str, float] = {}

    @staticmethod
    def _resume(st) -> None:
        # Only clear diagnostics owned by quota; preserve storage/space errors.
        if st.quota_stopped and (st.message or "").startswith(QUOTA_MESSAGE_PREFIX):
            st.message = ""
        st.quota_stopped = False

    @staticmethod
    def _index_failed(st, error: Exception) -> None:
        message = (f"{QUOTA_MESSAGE_PREFIX}容量索引暂不可用，已暂停录像；"
                   "索引恢复后自动重新检查配额")
        changed = not st.quota_stopped
        st.quota_stopped = True
        # Keep an existing connectivity/space diagnostic intact.
        if not st.message or st.message.startswith(QUOTA_MESSAGE_PREFIX):
            changed = changed or st.message != message
            st.message = message
        if changed:
            log.warning("容量索引操作失败，暂停录像，等待下一轮重试：%s",
                        type(error).__name__)

    async def enforce(self, storage_kind: str) -> int:
        """一轮清理；返回本轮删除段数。onFull=stop 时不删。

        SQLite 经独立串行线程，os.unlink 经存储隔离车道；
        某个删除超时 → StorageIOError（车道同步熔断、自愈重挂），
        本轮提前结束，已删段的索引行照常落账，未删的留给下一轮/scanner。
        """
        cfg = self.store.get().recording.quota
        st = self.storage.current_status()
        root = st.root
        generation = self.storage.io.generation
        storage_id = getattr(st, "storage_id", "")

        def same_volume() -> bool:
            current = self.storage.current_status()
            return (self.storage.io.generation == generation and current is st
                    and current.root == root and getattr(current, "storage_id", "") == storage_id)

        if cfg.mode == "percent":
            # SMB 路径绝不在这里直连 statvfs（卡死 NAS 上会 D 住整个工作轮）：
            # 只用 watchdog 刷新的容量缓存；缺失/过期 → 本轮跳过，不误判停录。
            cap = self.storage.capacity_cached()
            if cap is None:
                log.info("容量缓存缺失/过期（探活未完成或存储恢复中），跳过本轮配额清理")
                return 0
            limit = int(cap[0] * max(1, min(99, cfg.percent)) / 100)
        elif cfg.mode == "gb" and cfg.gb:
            limit = max(1, cfg.gb) * 1024 ** 3
        else:
            limit = None
        if not limit:
            if same_volume():
                self._resume(st)
            return 0
        try:
            used = await self.index.run(self.index.used_bytes, storage_kind)
            if not isinstance(used, int) or isinstance(used, bool) or used < 0:
                raise ValueError("invalid quota usage")
        except Exception as error:  # noqa: BLE001
            # Unknown usage is not zero. Do not change a newer storage view.
            if same_volume():
                self._index_failed(st, error)
            return 0
        if not same_volume():
            return 0
        if used <= limit:
            self._resume(st)
            return 0

        if cfg.onFull == "stop":
            # 停录策略：独立标志，存储探活循环不会把它清掉
            st.quota_stopped = True
            st.message = (f"{QUOTA_MESSAGE_PREFIX}已用 {used / 1024**3:.2f}GiB "
                          f"达到 {limit / 1024**3:.2f}GiB 上限（停录策略）")
            log.error(st.message)
            return 0

        min_age_ms = (cfg.minRetentionDays or 0) * 86_400_000
        target = int(limit * HIGH_WATER)
        now_ms = int(time.time() * 1000)
        deleted = 0
        skipped_poison = 0
        now_mono = time.monotonic()
        try:
            candidates = await self.index.run(self.index.oldest_segments, limit=500,
                                             min_age_ms=min_age_ms, now_ms=now_ms,
                                             storage=storage_kind)
        except Exception as error:  # noqa: BLE001
            if same_volume():
                self._index_failed(st, error)
            return 0
        for seg in candidates:
            if not same_volume():
                break
            if now_ms - seg["startTs"] < MIN_AGE_MS_FOR_DELETE:
                continue
            abs_path = os.path.join(root, seg["relPath"])
            size = seg["sizeBytes"]
            until = self._poison.get(abs_path)
            if until is not None:
                if until > now_mono:
                    skipped_poison += 1
                    continue
                self._poison.pop(abs_path, None)  # 退避到期，再给一次机会
            if is_writing(abs_path) or not self.playback.begin_delete(seg["id"]):
                continue
            try:
                # 本机维护隔离于实时建目录/探活；NAS 保留超时熔断。
                await self.storage.maintenance_io.run(
                    os.unlink, abs_path,
                    timeout=UNLINK_TIMEOUT_SEC, op="quota-unlink")
            except MaintenanceBusy:
                break  # 未提交的文件不应进入失败退避名单。
            except StorageIOError:
                # 结果未知，保留索引，稍后由 scanner 对账。
                self._poison[abs_path] = time.monotonic() + POISON_BACKOFF_SEC
                log.warning("配额清理：删除 %s 未完成，保留索引并暂缓该文件"
                            " %d 分钟（录像优先，到期重试），本轮提前结束",
                            abs_path, POISON_BACKOFF_SEC // 60)
                break
            except FileNotFoundError:
                pass  # 文件已经不在了，索引行照常清掉
            except OSError as e:
                # 2026-09-16 修复：非"文件已不存在"的失败（比如 CIFS soft
                # 挂载瞬时 I/O 错误——设计文档 §12 明确预期过这种故障模式）
                # 绝不能删索引行。此前这里无论 unlink 成败都无条件删行，
                # 物理文件其实还在磁盘/NAS 上，scanner 10s 内会按确定性 id
                # 重新扫描回索引，enforce() 60s 后又把它删一次——形成"删除-
                # 复活"死循环：空间从未真正释放，overwrittenSegments 只增
                # 不减、日志和 /stats 却一直显示"清理成功"。跳过本段，留给
                # 下一轮重试，继续处理候选池里的下一段（不 break，避免一次
                # 瞬时故障就让整轮清理提前停手）。
                log.warning(
                    "配额清理：删除 %s 失败（非文件不存在，跳过本段留给下一轮重试）: %s",
                    abs_path, e,
                )
                continue
            finally:
                self.playback.end_delete(seg["id"])
            if not same_volume():
                break  # 旧路径结果由后续扫描对账，不修改新存储视图。
            try:
                await self.index.run(self.index.delete, seg["id"])
            except Exception as error:  # noqa: BLE001
                # unlink may have succeeded. Keep the stale row for reconciliation
                # and never claim its index cleanup committed.
                if same_volume():
                    self._index_failed(st, error)
                return deleted
            deleted += 1
            used -= size
            try:
                await self.index.run(self.index.meta_incr, "overwrittenSegments")
            except Exception as error:  # noqa: BLE001
                if same_volume():
                    self._index_failed(st, error)
                return deleted
            if used <= target:
                break
        if not same_volume():
            return deleted
        if used <= limit:
            self._resume(st)
        else:
            # Retention, read/write leases, incomplete/recent segments, a bounded
            # candidate pool or unlink failures must not turn a cap into unlimited
            # growth. Keep the volume healthy and retry cleanup while capture is
            # paused. The supervisor already gates recording on quota_stopped.
            was_stopped = st.quota_stopped
            st.quota_stopped = True
            st.message = (f"{QUOTA_MESSAGE_PREFIX}已用 {used / 1024**3:.2f}GiB "
                          f"超过 {limit / 1024**3:.2f}GiB 上限，暂无法安全删除录像；"
                          "回收空间或提高配额后自动恢复")
            if not was_stopped:
                log.warning(st.message)
        if deleted:
            log.info("配额清理：LRU 删除 %d 段，本存储已用约 %dGB", deleted, used // 1024**3)
        if skipped_poison:
            log.info("配额清理：%d 个疑似 NAS 侧卡死文件在退避期内跳过（录像优先）",
                     skipped_poison)
        return deleted
