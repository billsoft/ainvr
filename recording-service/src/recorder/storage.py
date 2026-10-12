"""存储管理：本机目录 / SMB 挂载，统一"录像根目录"抽象。

铁律（用户决策）：NAS 连不上 = 停录报错，绝不降级写本机。
挂载由本服务（root systemd）用 mount.cifs 直接管理生命周期，
凭据落 /etc/ainvr-recorder/smb.cred（0600）。

2026-09 加固（NAS 反复冻死事件，内核栈 SMB2_lease_break→smb2_unlink）：
- 挂载选项加 ``nolease``（客户端不请求 SMB2 租约/oplock，从根上消除 lease
  break 等待路径；内核/cifs-utils 不支持时自动摘除重试并显著告警）与
  ``echo_interval=20``（更快发现死连接；注意它救不了"半活"服务器，真正的
  卡死兜底是 IsolatedIO 熔断 + 重挂，见 storage_io.py）；
- 挂载点状态判断只读 /proc/mounts，绝不对卡死的 sb 做 stat；
- 数据面 NAS 系统调用全部经 self.io（单工作线程 + 熔断 + 换代）；
- 挂载管理操作走独立单工作线程，超时后保留在途围栏，不占数据车道；
  管理车道只做 mount/umount，新挂载的建目录/写探测走可换代的验证车道
  （2026-09-24：探针写在写满的 NAS 上 D 住曾把围栏永久锁死、自愈失效）；
- 卷真实剩余空间低于停录线即停录并报"空间不足"（配额只管自己的段）；
- 故障恢复跳过 sync，直接懒卸载（lazy umount 只摘命名空间，不等待可能
  永久挂死的回写），再以新 superblock 重新挂载。
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from .config import DEFAULT_LOCAL_PATH, DEFAULT_MOUNT_POINT, SmbConfig, StorageConfig
from .logging_setup import get_logger
from .storage_io import IsolatedIO, MaintenanceIO, StorageIOError
from .storage_identity import storage_identity

log = get_logger("recorder.storage")

CRED_DIR = "/etc/ainvr-recorder"
CRED_PATH = f"{CRED_DIR}/smb.cred"
PROBE_BYTES = 16 * 1024 * 1024  # 测试连接测速 16MB
LIGHT_PROBE_BYTES = 64 * 1024   # 周期探活/恢复后验证：64KB 走通读写删即可
VERS_TRIALS = ("3.1.1", "3.0", "2.1")
# 挂载后 echo 心跳间隔（秒）：服务器无响应时内核约在 3×该值后判定死连接。
# 默认 60s 太久；lease break 卡死不吃这套超时，仅作快速失败的辅助。
ECHO_INTERVAL = 20
# 容量缓存有效期：watchdog 每 30s 刷新；缓存过期期间 percent 配额本轮跳过，
# 绝不拿陈旧/缺失容量误判 onFull=stop。
CAP_CACHE_TTL = 120.0
# 卷真实剩余空间守卫（2026-09-24 NAS 写满事件）：gb/percent 配额只管本服务
# 自己的段，挡不住其它数据或 NAS 回收站把卷写满；而 NAS 写满后对 SMB2
# WRITE 不回包，客户端写线程直接 D 住。低于停录线主动停录并明说原因，
# 回到恢复线以上才恢复（滞回，防止在阈值附近反复启停）。
MIN_FREE_BYTES = 5 * 1024 ** 3
RESUME_FREE_BYTES = 10 * 1024 ** 3
# 新挂载验证车道超时（秒）：恢复用轻探测，保存配置用 16MB 测速探测
RECOVER_PROBE_TIMEOUT = 30.0
APPLY_PROBE_TIMEOUT = 150.0
VERIFY_META_TIMEOUT = 15.0
# 自动恢复失败退避：30s 起翻倍，封顶 15 分钟
RECOVER_BACKOFF_BASE = 30.0
RECOVER_BACKOFF_MAX = 900.0
# 共享级回收站目录（QNAP / Synology / Samba vfs_recycle）


from .storage_types import StorageError
from .storage_probes import _probe_sync, _local_probe_sync, _find_recycle_dir


@dataclass
class StorageStatus:
    storage_id: str = ""
    kind: str = "local"
    healthy: bool = True
    message: str = ""
    root: str = DEFAULT_LOCAL_PATH
    mounted_version: str | None = None
    last_ok_ts: float = 0.0
    last_probe_ms: float | None = None
    failures: int = 0
    # 配额 onFull=stop 触发：与存储连通性健康分开，避免被探活循环重置
    quota_stopped: bool = False
    # 卷真实剩余空间低于停录线：同样与连通性分开（仍可回放），只停录
    space_low: bool = False
    # 非致命告警（如共享开了回收站），不影响录制
    warning: str = ""
    # 当前挂载对应的配置指纹（host/share/path/user/version），用于判断是否需要重挂
    fingerprint: tuple | None = None


def _run(cmd: list[str], timeout: int = 30) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def mounted_source(mountpoint: str) -> str | None:
    """从 /proc/mounts 读挂载源（//192.168.x/share）。纯本地文件，永不触 NAS。"""
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 2 and os.path.normpath(parts[1]) == os.path.normpath(mountpoint):
                    return parts[0]
    except OSError:
        pass
    return None


def mounted_options(mountpoint: str) -> str:
    """从 /proc/mounts 读挂载选项串（验证 nolease 等是否真正生效）。"""
    try:
        with open("/proc/mounts", "r", encoding="utf-8") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 4 and os.path.normpath(parts[1]) == os.path.normpath(mountpoint):
                    return parts[3]
    except OSError:
        pass
    return ""


def is_mountpoint(path: str) -> bool:
    """是否为挂载点：只查 /proc/mounts。

    不能用 os.path.ismount/isdir——它们会向（可能已 D 状态的）文件系统
    发 stat，挂载点卡死时调用方自己先挂死。
    """
    return mounted_source(path) is not None


def smb_fingerprint(smb: SmbConfig) -> tuple:
    return (smb.host, smb.share, smb.path, smb.username, smb.smbVersion)


def write_credentials(username: str, password: str) -> None:
    os.makedirs(CRED_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=CRED_DIR, prefix=".cred-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(f"username={username}\npassword={password}\n")
        os.chmod(tmp, 0o600)
        os.replace(tmp, CRED_PATH)
    except Exception:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def _subpath(root: str, smb_path: str) -> str:
    parts = [p for p in smb_path.replace("\\", "/").split("/") if p and p not in (".", "..")]
    return os.path.join(root, *parts) if parts else root


# ---------- 同步探测（在隔离工作线程/管理线程中执行，禁止在事件循环上直调） ----------

def _gb(n: int) -> str:
    return f"{n / 1024 ** 3:.1f}GB"


LOCAL_PROBE_TIMEOUT = 10.0
LOCAL_PROBE_STALE_SECONDS = 120.0


class StorageManager:
    """根据 config.recording.storage 维护唯一活动录像根目录。"""

    def __init__(self) -> None:
        self.status = StorageStatus()
        # 数据面存储调用的唯一入口（隔离线程 + 熔断 + 换代）
        self.io = IsolatedIO(on_trip=self._on_io_trip)
        self._maintenance_io = MaintenanceIO()
        # 存储管理（apply_config/test_storage/recover）串行锁：跨 await 使用，
        # 绝不能用 threading.Lock——在事件循环线程上抢阻塞锁等于冻死循环。
        self._mgmt_lock = asyncio.Lock()
        self._recover_lock = asyncio.Lock()
        # A timeout cancels only the waiter, never a kernel filesystem call.
        # Keep one outstanding management operation until it really completes.
        self._mgmt_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="storage-management")
        self._mgmt_pending = None
        # 新挂载/新目录的验证车道（建目录、statvfs、写探测）：与管理车道分开，
        # 探针写在半活 NAS 上 D 住时只废弃这条车道的线程并换代，不留围栏；
        # 也不借用数据车道，验证失败不污染当前在用存储的熔断状态。
        self._verify_io = IsolatedIO()
        # Local health probes must not queue behind quota work or stop all
        # writers for a transient filesystem stall. One outstanding call only.
        self._local_probe_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="local-probe")
        self._local_probe_pending = None
        self._local_probe_started = 0.0
        self._local_probe_root = None
        self._recover_attempts = 0
        self._next_recover_at = 0.0
        # (monotonic_ts, total_bytes, avail_bytes)；statvfs 只在隔离线程里做
        self._cap_cache: tuple[float, int, int] | None = None
        # nolease 支持情况：None=未探测，False=已确认不支持（不再尝试）
        self._nolease_supported: bool | None = None

    async def _management(self, fn, *args):
        if self._mgmt_pending is not None and not self._mgmt_pending.done():
            raise StorageError("上一次存储管理操作仍未结束，暂不能重挂或切换，请等待 NAS 恢复")
        pending = self._mgmt_executor.submit(fn, *args)
        self._mgmt_pending = pending
        wrapped = asyncio.wrap_future(pending)
        # Consume late errors even when the waiter times out. Do not cancel the
        # concurrent future: it is the fence against overlapping mount changes.
        wrapped.add_done_callback(lambda future: None if future.cancelled() else future.exception())
        try:
            return await asyncio.shield(wrapped)
        except asyncio.CancelledError:
            self.trip("storage-management", "存储管理操作超时，底层操作仍可能运行，暂停后续挂载")
            raise

    def shutdown(self) -> None:
        self._maintenance_io.shutdown()
        self._local_probe_pool.shutdown(wait=False, cancel_futures=True)
        self.io.shutdown()
        self._verify_io.shutdown()
        self._mgmt_executor.shutdown(wait=False, cancel_futures=True)

    @property
    def maintenance_io(self):
        return self._maintenance_io if self.status.kind == "local" else self.io

    async def _verify_root(self, root: str, probe, probe_args: tuple,
                           probe_timeout: float,
                           mount_root: str | None = None) -> tuple[int, int, str | None]:
        """在验证车道确认新根目录，→ (total, avail, 回收站目录名或 None)。

        SMB（给了 mount_root）：先对挂载点 statvfs + 查回收站（查询类请求，写满
        的 NAS 上照常秒回），空间不足则连建目录也跳过——2026-09-24 现场卡死
        的正是 mkdir 与写；空间够才建目录、写探测。本机：建目录 → statvfs →
        写探测（目录可能尚不存在）。任何失败/超时抛 StorageError；超时线程随
        验证车道换代被废弃，下一次验证用新线程。
        """
        vio = self._verify_io
        try:
            recycle = None
            if mount_root is not None:
                total, avail = await vio.run(self.fs_stats, mount_root,
                                             timeout=VERIFY_META_TIMEOUT, op="verify-statvfs")
                recycle = await vio.run(_find_recycle_dir, mount_root,
                                        timeout=VERIFY_META_TIMEOUT, op="verify-recycle")
                if avail < MIN_FREE_BYTES:
                    return total, avail, recycle
                await vio.run(os.makedirs, root, exist_ok=True,
                              timeout=VERIFY_META_TIMEOUT, op="verify-mkdir")
            else:
                await vio.run(os.makedirs, root, exist_ok=True,
                              timeout=VERIFY_META_TIMEOUT, op="verify-mkdir")
                total, avail = await vio.run(self.fs_stats, root,
                                             timeout=VERIFY_META_TIMEOUT, op="verify-statvfs")
                if avail < MIN_FREE_BYTES:
                    return total, avail, recycle
            await vio.run(probe, *probe_args, timeout=probe_timeout, op="verify-probe")
            return total, avail, recycle
        except StorageIOError as e:
            raise StorageError(f"新挂载验证无响应：{e}") from e
        except OSError as e:
            raise StorageError(f"存储目录不可写：{e}") from e
        finally:
            if vio.tripped:
                vio.reset("验证车道换代")

    def _apply_space(self, total: int, avail: int) -> None:
        """按卷真实剩余空间置/清 space_low（事件循环线程调用）。"""
        self._cap_cache = (time.monotonic(), total, avail)
        st = self.status
        kind = "NAS " if st.kind == "smb" else "本机磁盘"
        if avail < MIN_FREE_BYTES or (st.space_low and avail < RESUME_FREE_BYTES):
            msg = (f"{kind}可用空间不足（剩余 {_gb(avail)}，停录线 {_gb(MIN_FREE_BYTES)}），"
                   f"已停止录制以免写满卡死；请清理存储空间"
                   + ("（含 NAS 回收站）" if st.kind == "smb" else "")
                   + f"，剩余恢复到 {_gb(RESUME_FREE_BYTES)} 以上自动恢复录制")
            if not st.space_low:
                log.error(msg)
            st.space_low = True
            st.message = msg
        elif st.space_low:
            st.space_low = False
            st.message = ""
            log.info("%s可用空间已恢复（剩余 %s），恢复录制", kind, _gb(avail))

    def _apply_recycle(self, recycle: str | None) -> None:
        st = self.status
        if recycle:
            warning = (f"NAS 共享开启了回收站（{recycle}）：滚动覆盖删除的录像会进入"
                       "回收站继续占用空间，最终写满 NAS；请在 NAS 上对该共享关闭"
                       "回收站，或把录像目录排除在回收站之外")
            if st.warning != warning:
                log.warning(warning)
            st.warning = warning
        else:
            st.warning = ""

    def recover_due(self) -> bool:
        """自动恢复退避是否已到期（纯内存）。"""
        return time.monotonic() >= self._next_recover_at

    @property
    def recover_attempts(self) -> int:
        return self._recover_attempts

    def _recover_failed(self, reason: str) -> None:
        self._recover_attempts += 1
        n = self._recover_attempts
        delay = min(RECOVER_BACKOFF_BASE * 2 ** (n - 1), RECOVER_BACKOFF_MAX)
        self._next_recover_at = time.monotonic() + delay
        st = self.status
        st.healthy = False
        st.message = f"NAS 自动恢复失败（第 {n} 次）：{reason}；{int(delay)}s 后重试，录制已停止"
        log.warning(st.message)

    def _recover_reset(self) -> None:
        self._recover_attempts = 0
        self._next_recover_at = 0.0

    # ---------- 容量缓存（数据线程写、事件循环读，tuple 引用赋值原子） ----------

    @staticmethod
    def fs_stats(path: str) -> tuple[int, int]:
        """→ (该存储总字节, 可用字节)。挂载点 statvfs 即共享容量。

        注意：同步调用，调用方必须确保在隔离线程中（或本地路径）。
        """
        st = os.statvfs(path)
        return st.f_blocks * st.f_frsize, st.f_bavail * st.f_frsize

    def _update_cap_cache(self, root: str) -> bool:
        try:
            total, avail = self.fs_stats(root)
        except OSError:
            return False
        self._cap_cache = (time.monotonic(), total, avail)
        return True

    def capacity_cached(self, max_age: float = CAP_CACHE_TTL) -> tuple[int, int] | None:
        c = self._cap_cache
        if c is None:
            return None
        ts, total, avail = c
        if time.monotonic() - ts > max_age:
            return None
        return total, avail

    # ---------- 熔断联动 ----------

    def _on_io_trip(self, op: str, message: str) -> None:
        """跳闸点同步回调（在事件循环线程执行）：内存标志立即生效，
        下一个 supervisor tick（≤3s）即停光录制，不等 30s 探活。"""
        st = self.status
        if st.healthy:
            st.healthy = False
            st.failures += 1
            kind = "NAS" if st.kind == "smb" else "存储"
            st.message = (
                f"{kind}操作 {op} 无响应（{message}），已自动停录；"
                + ("NAS 将自动懒卸载并重挂恢复，期间可在控制台手动切换本机存储"
                   if st.kind == "smb" else "将重新检查本机存储后恢复录制")
            )
            log.error(st.message)

    def trip(self, op: str, message: str) -> None:
        """外部强信号（如 ffmpeg 长时间不出段）主动触发熔断。"""
        self.io.trip(op, message)

    # ---------- SMB 挂载 ----------

    def _build_mount_opts(self, vers: str, use_nolease: bool) -> str:
        opts = [
            # 不显式加 iocharset=utf8：部分精简内核（如 Tegra
            # 5.15.148）未编 nls_utf8.ko，加了反而 mount error(79)；
            # 现代 cifs 默认即 UTF-8，实测中文文件名读写正常。
            f"credentials={CRED_PATH}",
            f"vers={vers}",
            "file_mode=0660", "dir_mode=0770",
            "_netdev", "mfsymlinks",
            "soft",                       # 常规 I/O 无响应时出错而非无限等
            f"echo_interval={ECHO_INTERVAL}",
            "cache=strict",
        ]
        if use_nolease:
            # 2026-09 事件主修复：不向服务器请求租约/oplock，unlink 等路径
            # 不再进入 SMB2_lease_break 等待（实测卡死栈的直接元凶）。
            # 代价：数据/元数据缓存回源变多，顺序写分段与局域网带宽不受影响。
            opts.append("nolease")
        return ",".join(opts)

    @staticmethod
    def _looks_invalid_option(stderr: str) -> bool:
        s = (stderr or "").lower()
        return ("invalid argument" in s or "mount error(22)" in s
                or "unknown mount option" in s or "unrecognized" in s)

    def _mount_once(self, smb: SmbConfig, vers: str, use_nolease: bool):
        cmd = [
            "mount", "-t", "cifs",
            f"//{smb.host}/{smb.share}", DEFAULT_MOUNT_POINT,
            "-o", self._build_mount_opts(vers, use_nolease),
        ]
        try:
            return _run(cmd, timeout=30)
        except subprocess.TimeoutExpired:
            return None  # 哨兵：mount.cifs 30s 无返回（用户态进程已被杀）

    def _mount_cifs(self, smb: SmbConfig) -> str:
        os.makedirs(DEFAULT_MOUNT_POINT, exist_ok=True)
        versions = VERS_TRIALS if smb.smbVersion == "auto" else (smb.smbVersion,)
        last_err = ""
        for vers in versions:
            if is_mountpoint(DEFAULT_MOUNT_POINT):
                return vers  # 上一轮已挂上（busy）
            use_nolease = self._nolease_supported is not False
            r = self._mount_once(smb, vers, use_nolease)
            if r is None:
                last_err = f"SMB {vers} 挂载超时（30s）"
                continue
            if r.returncode == 0 and is_mountpoint(DEFAULT_MOUNT_POINT):
                self._note_mount_ok(smb, vers, use_nolease)
                return vers
            err = ((r.stderr or r.stdout or "未知错误").strip().splitlines() or ["未知错误"])[-1]
            if is_mountpoint(DEFAULT_MOUNT_POINT):
                # busy/已挂载视为成功
                self._note_mount_ok(smb, vers, use_nolease)
                return vers
            last_err = err
            # nolease 不被内核/cifs-utils 接受（EINVAL）：本进程生命周期内
            # 摘掉它重试一次；这是"带故障运行"，必须显著告警。
            if (use_nolease and self._nolease_supported is None
                    and self._looks_invalid_option(err)):
                self._nolease_supported = False
                log.error(
                    "当前内核/cifs-utils 不接受 nolease 挂载选项（%s），"
                    "已回退挂载：失去对 SMB2 租约中断卡死的客户端防护，"
                    "请尽快升级内核（≥5.12）/cifs-utils 并优先排查 NAS 侧", err)
                r2 = self._mount_once(smb, vers, False)
                if r2 is not None and is_mountpoint(DEFAULT_MOUNT_POINT):
                    self._note_mount_ok(smb, vers, False)
                    return vers
                last_err = ("回退挂载同样失败：" + (
                    (r2.stderr or r2.stdout or "").strip().splitlines() or ["未知错误"])[-1]
                    if r2 is not None else "回退挂载超时（30s）")
        raise StorageError(f"挂载 //{smb.host}/{smb.share} 失败：{last_err}")

    def _note_mount_ok(self, smb: SmbConfig, vers: str, use_nolease: bool) -> None:
        log.info("SMB 挂载成功 //%s/%s vers=%s nolease=%s",
                 smb.host, smb.share, vers, use_nolease)
        if use_nolease:
            actual = mounted_options(DEFAULT_MOUNT_POINT)
            if "nolease" not in actual:
                log.warning("挂载成功但 /proc/mounts 未见 nolease（实际选项：%s），"
                            "租约卡死防护可能未真正生效", actual or "?")

    def _umount(self, lazy: bool = False) -> None:
        if not is_mountpoint(DEFAULT_MOUNT_POINT):
            return
        if lazy:
            # 故障恢复路径：绝不先 sync——sync(2) 刷全机所有文件系统，cifs
            # 卡死时它自己就能进 D 状态且杀用户态进程也没用。lazy 只摘挂载
            # 命名空间、不等待回写，对 cifs 通常立即返回；旧 sb 在最后一个
            # 引用（含 D 状态 ffmpeg）释放后由内核继续/丢弃回写。
            _run(["umount", "-l", DEFAULT_MOUNT_POINT], timeout=15)
            if is_mountpoint(DEFAULT_MOUNT_POINT):
                raise StorageError("NAS 懒卸载失败，拒绝复用旧挂载")
            log.warning("已执行懒卸载 %s（故障恢复路径）", DEFAULT_MOUNT_POINT)
            return
        r = _run(["umount", DEFAULT_MOUNT_POINT], timeout=15)
        if r.returncode != 0 and is_mountpoint(DEFAULT_MOUNT_POINT):
            log.warning("umount 失败（%s），转 lazy", (r.stderr or "").strip())
            _run(["umount", "-l", DEFAULT_MOUNT_POINT], timeout=15)
        if is_mountpoint(DEFAULT_MOUNT_POINT):
            raise StorageError("NAS 卸载失败，拒绝复用旧挂载")

    def _mount_smb_sync(self, smb: SmbConfig) -> str:
        """管理车道：凭据检查 → 必要时换挂 → 挂载，返回协商版本。

        只做挂载命名空间操作（mount/umount 子进程都有超时），绝不在这里对
        共享做文件读写：2026-09-24 NAS 写满时探针写 D 住，旧实现把它放在管理
        车道，围栏永远不结束，此后每轮自愈都被"仍未结束"挡回。建目录与写
        探测交给 _verify_root（验证车道，可换代）。
        """
        if not os.path.exists(CRED_PATH):
            raise StorageError("缺少 SMB 凭据文件（服务应以 root 安装运行）")
        if is_mountpoint(DEFAULT_MOUNT_POINT):
            src = mounted_source(DEFAULT_MOUNT_POINT) or ""
            wanted = f"//{smb.host}/{smb.share}"
            if src.lower() != wanted.lower():
                self._umount()
        if not is_mountpoint(DEFAULT_MOUNT_POINT):
            return self._mount_cifs(smb)
        return "reused"

    async def _connect_smb(self, smb: SmbConfig, *, mount_timeout: float,
                           probe_bytes: int, probe_timeout: float) -> tuple[str, str, int, int, str | None]:
        """挂载（管理车道）+ 验证（验证车道）→ (vers, root, total, avail, recycle)。"""
        vers = await asyncio.wait_for(
            self._management(self._mount_smb_sync, smb), timeout=mount_timeout)
        root = _subpath(DEFAULT_MOUNT_POINT, smb.path)
        total, avail, recycle = await self._verify_root(
            root, _probe_sync, (root, probe_bytes), probe_timeout,
            mount_root=DEFAULT_MOUNT_POINT)
        return vers, root, total, avail, recycle

    # ---------- 对外操作（全部 async，管理操作在一次性线程 + 显式超时） ----------

    async def apply_config(self, storage: StorageConfig, *, reconnect: bool = False) -> None:
        """保存配置时调用：切到目标存储并确认可写，失败抛 StorageError 且保持旧状态。"""
        async with self._mgmt_lock:
            if storage.kind == "local":
                root = storage.localPath or DEFAULT_LOCAL_PATH
                try:
                    # 本机路径也可能卡（劣质 USB/盘故障）：同样走验证车道
                    total, avail, _ = await self._verify_root(
                        root, _local_probe_sync, (root,), 20)
                except StorageError as e:
                    raise StorageError(f"本机目录 {root} 验证失败：{e}") from e
                if is_mountpoint(DEFAULT_MOUNT_POINT):
                    await asyncio.wait_for(
                        self._management(self._umount), timeout=40)
                self.status = StorageStatus(
                    storage_id=storage_identity(storage),
                    kind="local", healthy=True, root=root, last_ok_ts=time.time(),
                )
                self._apply_space(total, avail)
                self._recover_reset()
                # 切存储 = 全新一代：丢弃在途/熔断状态，旧 root 上迟到的
                # 结果由 generation 与 scanner 对账自然作废
                self.io.reset("切换到本机存储")
                log.info("存储切换完成：local → %s", root)
                return

            smb = storage.smb
            if smb is None:
                raise StorageError("选择 NAS 存储时必须提供 SMB 配置")
            if smb.password:
                await asyncio.wait_for(self._management(write_credentials, smb.username, smb.password), timeout=10)
            if reconnect:
                await asyncio.wait_for(self._management(self._umount), timeout=40)
            vers, root, total, avail, recycle = await self._connect_smb(
                smb, mount_timeout=180, probe_bytes=PROBE_BYTES,
                probe_timeout=APPLY_PROBE_TIMEOUT)
            self.status = StorageStatus(
                storage_id=storage_identity(storage),
                kind="smb", healthy=True, message="", root=root,
                mounted_version=vers, last_ok_ts=time.time(),
                fingerprint=smb_fingerprint(smb.model_copy(update={"password": ""})),
            )
            self._apply_space(total, avail)
            self._apply_recycle(recycle)
            self._recover_reset()
            self.io.reset("切换到 NAS 存储")
            log.info("存储切换完成：smb → %s", root)

    def active_root(self) -> tuple[str, str]:
        """→ (root, kind)；不健康抛 StorageError（监督器据此停录，不降级）。

        纯内存 + /proc/mounts 判断，不对挂载点做 stat（卡死 sb 上 stat 会 D）。
        目录丢失由写入失败与周期探活暴露。
        """
        st = self.status
        if st.quota_stopped:
            raise StorageError(st.message or "已达到存储配额上限（策略：停止录制）")
        if st.space_low:
            raise StorageError(st.message or "存储可用空间不足，已停止录制")
        if not st.healthy:
            raise StorageError(st.message or "存储不可用，已停止录制")
        if st.kind == "smb" and mounted_source(DEFAULT_MOUNT_POINT) is None:
            st.healthy = False
            st.message = "NAS 挂载丢失"
            raise StorageError(st.message)
        return st.root, st.kind

    def current_status(self) -> StorageStatus:
        return self.status

    def media_root(self) -> str:
        """回放/下载取文件：只读访问，配额停录不影响历史回放。

        同样不做 isdir stat；文件存在性检查由调用方在隔离线程中完成。
        """
        st = self.status
        if st.kind == "smb" and mounted_source(DEFAULT_MOUNT_POINT) is None:
            raise StorageError("NAS 未挂载，录像暂不可读")
        return st.root

    # ---------- 周期探活（30s；数据面经熔断执行器） ----------

    async def watchdog_check(self) -> bool:
        """SMB 小文件探活，失败置 unhealthy（不卸载，恢复交给 try_recover）。"""
        st = self.status
        if self._mgmt_lock.locked():
            return True  # Configuration owner is validating; do not probe stale roots.
        if st.kind != "smb":
            try:
                if self._local_probe_pending is not None and self._local_probe_root != st.root:
                    if not self._local_probe_pending.done():
                        return st.healthy
                    # A verified configuration switch supersedes the old root,
                    # including its eventual errors. Never apply them here.
                    try:
                        self._local_probe_pending.result()
                    except Exception:
                        pass
                    self._local_probe_pending = None
                if self._local_probe_pending is None:
                    root = st.root
                    def probe():
                        total, avail = self.fs_stats(root)
                        # No write probe on a nearly full filesystem.
                        if avail >= MIN_FREE_BYTES:
                            _local_probe_sync(root)
                        return total, avail
                    self._local_probe_started = time.monotonic()
                    self._local_probe_root = root
                    self._local_probe_pending = self._local_probe_pool.submit(probe)
                pending = self._local_probe_pending
                wrapped = asyncio.wrap_future(pending)
                wrapped.add_done_callback(lambda f: None if f.cancelled() else f.exception())
                total, avail = await asyncio.wait_for(asyncio.shield(wrapped), LOCAL_PROBE_TIMEOUT)
                self._local_probe_pending = None
                if self._local_probe_root != st.root or st is not self.status:
                    return st.healthy  # a configuration switch owns the new root
                self._apply_space(total, avail)
                st.warning = ""
            except asyncio.TimeoutError:
                elapsed = time.monotonic() - self._local_probe_started
                st.warning = f"本机存储探测延迟 {elapsed:.0f} 秒，写入仍由各通道缓冲保护"
                log.warning("local_probe_slow elapsed_sec=%.3f root=%s healthy=%s", elapsed, st.root, st.healthy)
                # A long loss of observability still fails closed; do not keep
                # recording indefinitely against an unresponsive/full volume.
                if elapsed >= LOCAL_PROBE_STALE_SECONDS:
                    st.healthy = False
                    st.message = "本机存储持续无响应，已暂停录制，等待原探测完成"
                return st.healthy
            except (StorageIOError, OSError, StorageError) as e:
                self._local_probe_pending = None
                if not self.io.tripped:
                    st.healthy = False
                    st.message = f"本机目录不可写：{e}"
                return False
            except Exception as e:
                # Retire a completed failed probe. Reusing it forever prevents
                # recovery even when the next probe would succeed.
                self._local_probe_pending = None
                st.healthy = False
                st.message = f"本机存储探测失败：{e}"
                log.exception("local_probe_failed root=%s", st.root)
                return False
            st.healthy = True
            if not st.space_low:
                st.message = ""
            st.last_ok_ts = time.time()
            st.failures = 0
            if self.io.tripped:
                self.io.reset("本机存储探测恢复")
            return True

        if mounted_source(DEFAULT_MOUNT_POINT) is None:
            if not self.io.tripped:
                st.healthy = False
                if self._recover_attempts == 0:  # 别盖掉"第 N 次恢复失败…后重试"
                    st.message = "NAS 挂载丢失，录制已停止"
                st.failures += 1
            return False
        if self.io.tripped:
            # 故障发现与停录已在跳闸点完成；此轮不重复探测，避免在旧 sb 上
            # 再堆 D 状态线程。恢复由 storage_watchdog_loop 调 try_recover。
            return False
        try:
            # 先 statvfs（QUERY_INFO，写满的 NAS 上照常秒回），空间不足就不写
            # 探测——NAS 写满后对 SMB2 WRITE 不回包，探针写会把线程送进 D 状态
            total, avail = await self.io.run(self.fs_stats, st.root,
                                             timeout=10, op="nas-statvfs")
            self._apply_space(total, avail)
            if not st.space_low:
                await self.io.run(_probe_sync, st.root, LIGHT_PROBE_BYTES,
                                  timeout=15, op="nas-probe")
        except (StorageIOError, OSError, StorageError) as e:
            if not self.io.tripped:
                # CircuitOpen 分支消息由 _on_io_trip 写得更具体，不覆盖
                st.healthy = False
                st.message = f"NAS 探活失败：{e}（已停录，等待自动重挂）"
                st.failures += 1
            return False
        st.healthy = True
        if not st.space_low:
            st.message = ""
        st.last_ok_ts = time.time()
        st.last_probe_ms = None  # 周期轻探测不测速；测速只在测试连接时返回
        st.failures = 0
        return True

    async def try_recover(self, storage_cfg: StorageConfig | None) -> bool:
        """storage_error 周期恢复：懒卸载旧 sb → 新挂载 → 新 sb 写探测 → 换代。

        单飞（_recover_lock）：watchdog 与外部手动重试不会并发挂载。
        注意：调用本方法前 supervisor 已因 unhealthy 停光 ffmpeg；杀不掉的
        D 状态 ffmpeg 由 supervisor 的 orphan 集合隔离，lazy umount 后它们
        持有旧 sb，不参与新录制（spawn 围栏），杜绝双写者。
        """
        if storage_cfg is None:
            return False
        if storage_cfg.kind == "local":
            try:
                if self._local_probe_pending is not None:
                    return await self.watchdog_check()
                await self.apply_config(storage_cfg)
                return True
            except Exception:
                return False
        if storage_cfg.smb is None:
            return False
        if not self.recover_due():
            return False  # 退避期内：不碰挂载，不堆线程
        # 恢复可以合法持续超过 5s；超时只跳过本轮，不能释放另一个协程的锁。
        try:
            await asyncio.wait_for(self._recover_lock.acquire(), timeout=5)
        except asyncio.TimeoutError:
            log.warning("已有存储恢复进行中，本轮跳过（不接管持有者的锁）")
            return False
        mgmt_acquired = False
        try:
            try:
                await asyncio.wait_for(self._mgmt_lock.acquire(), timeout=5)
                mgmt_acquired = True
            except asyncio.TimeoutError:
                log.warning("存储配置/测试正在进行，本轮恢复跳过")
                return False
            smb = storage_cfg.smb
            try:
                # A failed configuration attempt may have written new credentials
                # before timing out. Recovery always restores the authoritative
                # committed credentials once the outstanding worker has finished.
                if smb.password:
                    await asyncio.wait_for(
                        self._management(write_credentials, smb.username, smb.password), timeout=10)
                # 1) 懒卸载：不 sync、不等待卡死引用（subprocess 自身有 15s 超时）
                await asyncio.wait_for(
                    self._management(self._umount, True), timeout=30)
                # 2) 重新挂载（管理车道，只做 mount）+ 新 sb 建目录/容量/写探测
                #    （验证车道：新 sb 仍半活导致探针 D 住，只废弃该车道线程并
                #    换代，不留管理围栏，下一轮照常重挂）
                vers, root, total, avail, recycle = await self._connect_smb(
                    smb, mount_timeout=120, probe_bytes=LIGHT_PROBE_BYTES,
                    probe_timeout=RECOVER_PROBE_TIMEOUT)
            except StorageError as e:
                self._recover_failed(str(e))
                return False
            except asyncio.TimeoutError:
                self._recover_failed("懒卸载/重挂在限定时间内未完成")
                return False
            except Exception as e:  # noqa: BLE001
                self._recover_failed(f"异常 {e}")
                return False
            # 3) 新 superblock 验证通过：熔断换代，数据车道用全新工作线程
            self.io.reset("NAS 懒卸载重挂成功")
            self.status = StorageStatus(
                storage_id=storage_identity(storage_cfg),
                kind="smb", healthy=True, message="", root=root,
                mounted_version=vers, last_ok_ts=time.time(),
                fingerprint=smb_fingerprint(smb.model_copy(update={"password": ""})),
                # 同一存储重挂：空间滞回状态延续，避免在两条线之间误恢复录制
                space_low=self.status.space_low,
            )
            self._apply_space(total, avail)
            self._apply_recycle(recycle)
            self._recover_reset()
            log.info("NAS 自动恢复完成：%s（vers=%s）", root, vers)
            return True
        finally:
            if mgmt_acquired:
                self._mgmt_lock.release()
            self._recover_lock.release()
