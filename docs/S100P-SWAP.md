# S100P swap 安全约定

`deploy/s100p/ainvr-swap.sh` 与 `ainvr-swap.service` 已于 2026-11-13 在 190 安装，
并执行 systemd 服务重启验证。原有 2 GiB zram + 4 GiB SSD swap 的设备、容量和
优先级保持不变；没有执行 `swapoff` 或重置 zram。`ExecStop` 为空，
`vm.swappiness=10`。部署证据在 `test/results/product-release-20261113/publication.json`。
本轮没有重启开发板，不能用这次服务重启替代冷启动、断电和新建 swap 的验收。

## 启动行为

- `start` 需要 root，使用 `/run/ainvr-swap/lock` 防止本脚本并发执行。
- 默认 `AINVR_SWAP_ZRAM_MIB=2048`、`AINVR_SWAP_FILE_MIB=4096`；设为 `0`
  仅禁止创建对应层，不关闭或调整已有 swap。大小必须为无前导零的非负整数，
  上限分别为 65536 和 262144 MiB。
- 已启用的任意 `/dev/zramN` 保持原大小、算法、优先级。没有已启用 zram 时，
  `zramctl --find` 只选择空闲设备；先读取该设备的 `comp_algorithm`，可用时选择
  zstd，否则保留内核默认算法，然后设置容量。不通过失败创建探测算法，不重置已有
  已初始化设备，即使它暂未启用 swap。新设备 swap 优先级为 100。
- SSD 默认 `/mnt/ainvr-ssd`，可通过 `AINVR_SWAP_SSD` 指定。必须为已挂载的
  独立于根文件系统的 ext4/xfs、规范绝对路径，不接受符号链接、空白或反斜杠。
  挂载缺失时跳过 SSD 层，继续尝试 zram；不尝试挂载，不退回系统盘。
  此检查不鉴别硬件介质，管理员须确保指定挂载确实来自 SSD。
- SSD 挂载目录和 `swap/` 必须由 root 拥有且不可由组/其他用户写入。
  已启用的 `swap/ainvr.swap` 保持原样；未启用文件必须是 root 拥有的单硬链接
  普通文件，禁止自动调整大小。已格式化文件复用，权限收紧至 0600。
- 启动最后设置全局 `vm.swappiness`，默认 `AINVR_SWAPPINESS=10`，允许 0–200。
  这不是每服务参数，也不会在停止时恢复。任一启用步骤失败会返回非零；已成功
  启用的部分不会回滚，以免在内存压力下关闭 swap。

## 中断恢复与文件保护

新文件采用 0600 的 `.ainvr.swap.*` 临时文件，先分配、`mkswap`、同步，再同目录
不覆盖重命名发布；最终路径不会出现只分配未格式化的文件。正常失败和 TERM/INT/HUP
清理本次临时文件；SIGKILL/断电可能留下未发布的临时文件，它不阻止下次重试。
不自动扫描或删除历史临时文件：维护时先确认无创建任务、文件未被使用，再针对性清理。

旧脚本留下的同尺寸文件，先用 `blkid -p` 检查 swap 签名。只有逐字节确认**全零**
才补做 `mkswap`，修复 `fallocate` 完成但格式化未执行的状态；未知非零内容、
尺寸不符或链接异常均保留并报错，禁止盲目覆盖。全零检查会顺序读取整个文件。
若旧文件补格式化时再次中断并留下损坏的非零头部，则保留待人工检查。
稀疏文件、碎片/文件系统限制等仍可能导致真实 `swapon` 失败；脚本保留文件并报告失败。

## 停止与维护

`stop` 仅输出说明；service 没有 `ExecStop`，停止/重启该服务不会执行 `swapoff`、
重置 zram 或删除 swap 文件。操作系统关机流程负责最终 swap 关闭。
扩缩容、替换文件、关闭 swap 或清理创建失败后已初始化的 zram，需要另外的显式维护
操作和足够内存余量；本脚本不自动执行这些动作。不与其他 swap 管理服务并发配置同一
设备/路径：本脚本锁不协调其他服务或管理员操作。

service 移除了 `RequiresMountsFor`，避免可选 SSD 缺失阻断 zram 启动。
它在 `local-fs.target` 后运行，保持对 AINVR 服务的启动顺序约束；该顺序本身不建立
服务依赖，也不保证两层 swap 均可用。启动超时为 180 秒。

## 隔离回归测试

在 Linux 仓库目录运行（root 仅用于构造 chroot）：

```sh
python3 test/test_ainvr_swap.py
sh -n deploy/s100p/ainvr-swap.sh
systemd-analyze verify deploy/s100p/ainvr-swap.service
```

Python 标准库测试复制允许的文件工具及动态库到 `test/` 下的临时 chroot。
chroot 内无真实 `/proc`、`/sys`、块设备或 swap 命令；子进程丢弃 capabilities，
禁止提权。`mkswap`、`swapon`、`swapoff`、zram、挂载探测和 `sysctl` 均为 mock。
测试包含等尺寸全零恢复、原有 swap 保留、路径/权限/硬链接检查、并发锁、分配与格式化
失败、TERM/KILL 中断、原子发布竞争、重试及停止语义。测试不代表真实内核 swap 或
开机/关机验收；`systemd-analyze verify` 只检查单元定义，不启动服务。

尚需在后续授权维护窗口验证：真实 zram 创建/压缩算法、SSD `swapon` 文件布局兼容性、
断电持久性、SSD 缺失时的开机行为、systemd 关机顺序与负载下内存压力。
