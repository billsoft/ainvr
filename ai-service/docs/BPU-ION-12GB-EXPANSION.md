# 把 BPU 可用内存扩到 12 GiB：成功路径与必踩的坑

日期：2026-10-28 方案，2026-10-30 在 189 板（S100P，24 GiB 内存，系统 4.0.5，内核 `6.1.158-rt58-DR-4.0.5-2603191535`）实施成功。
**状态：已实施并验证；软件预算常量已改，search、llm 两个服务已于 2026-10-30 12:20 部署新二进制并验证（见第 6 节）。源码改动在板上仓库未提交。**

## 1. 结论

- 不重刷固件，不改 U-Boot 代码：只把 `/boot/hobot/rdk-s100p-v1p0.dtb` 里 `ion_carveout` 的**大小**从 128 MiB 改成 **4480 MiB（`0x118000000`）**，重启一次。
- 结果：ION 总量 = pool 7680 + carveout 4480 + cma 128 = **12288 MiB**；Linux 可用内存从 15895 MiB 降到 **11543 MiB**。
- 这里的"12 GiB"是**整个 ION**（BPU、VPU、JPU、PYM、GDC 等共用），不是 BPU 专用。
- BPU 实测可用：用户态分配器一共分到 12213 MiB；把 pool 和 cma 占满后加载模型，只能从 carveout 取内存，BPU 推理输出与基线逐位一致。
- 重启后 ssh 约 27 秒恢复，16 个服务自动回来。

## 2. 成功路径（照做即可）

前提：有人在场，能物理接串口线。全程只在被允许时才重启。

1. **只读摸底**：确认 `/boot` 挂载（`mmcblk0p12`，60 MB，剩 18 MB）、当前 dtb 哈希、服务清单、`free -m`、`/proc/bootloader_log` 里的 `alloc_ion_*` 三行、U-Boot 环境镜像里没有 `ion_*` 变量。
2. **备份**（板子不动）：把 U-Boot、BL31、OP-TEE、ubootenv、两个 boot 分区、eMMC 硬件 boot 分区、`/boot` 文件包、启动日志整份拷到 SSD 和 PC，生成 `SHA256SUMS.txt`；另存"改动前基线"（ION 行、free、meminfo、iomem、服务状态）。
3. **准备 dtb**：用 `make_ion12_dtb.sh` 从当前 dtb 反编译、只改 `ion_carveout` 的 `reg` 一行、编回 `patched.dtb`，反编译对比确认只差这一行。
4. **准备好救援**：PC 上放齐官方镜像、XBurn、驱动、`RESCUE.md`；**把串口线接到板子和 PC，用 921600 8N1 开一个后台抓日志程序**（见第 3 节）。
5. **替换 dtb**：`CONFIRM=yes-user-approved-ion12 bash ion12_apply.sh`。脚本会校验当前 dtb 哈希、校验备份存在、校验剩余空间，保留一份 `*.pre-ion12`，先写 `.new` 再原子 `mv`，校验最终哈希，停掉 ainvr 服务，**不重启**。
6. **重启**：`systemctl reboot`；后台轮询 ssh。
7. **启动层验证**：`bash ion12_verify.sh`，逐项 PASS/FAIL：
   - pool `0x1e0000000 @0x400000000`（不变）
   - carveout `0x118000000 @0x800000000`
   - cma 仍是 128 MiB
   - MemTotal 在 11000～12000 MiB
   - 重启前在跑的服务全部恢复（最多等 120 秒）
   - dmesg 无 ION/SMMU/panic
8. **分配与 BPU 验证**（先停 ai、llm、search，结束自动恢复）：
   - `ion_spill_test_layout.py`：分配到失败，确认总量与归属。
   - `ion_prefill_model_test.py <模型.hbm>`：占满其余堆，只留 carveout，再加载模型推理，比对输出。
9. **硬件回归**：`hwtest_ion12.sh`，两轮（普通 / 用 `ion_hold_pool.py` 占满 pool），测 memory、gpu、bpu、vpu（1080p、4K）、jpu 4K、pym 4K、gdc、stitch、isp、storage。
10. **最后才改软件预算**（见第 6 节）。

### 实测结果

| 项 | 结果 |
|---|---|
| 启动布局 | pool 7680 MiB @0x400000000；carveout 4480 MiB @0x800000000；cma 128 MiB @0x5e0000000 |
| `ion12_verify.sh` | 6 项全 PASS |
| 分配探测 | 总 12213 MiB：pool 7680 + carveout 4453 + cma 80，缓存/非缓存一致 |
| 模型级验证 | pool、cma 占满后加载 yolo26x，从 carveout 取 128 MiB，输出逐位一致 |
| 硬件回归两轮 | memory / bpu / vpu 1080p 与 4K / jpu 4K / pym 4K / gdc / stitch / isp / storage 全部 PASS；gpu 为 PARTIAL，只差"OpenGL-ES 渲染"一项，需要显示器，10-09 的旧结果同样如此 |
| 内核日志 | 无 IOMMU/SMMU 故障、无 panic、无 OOM |

## 3. 必踩的坑指南

### 改 dtb 前后

1. **dtb 里写的起始地址会被 U-Boot 忽略**，只有 `reg` 的**大小**有效，位置由 U-Boot 按各内存段首次适配自己排。别花时间去调地址。
2. **`/boot/hobot/*.dtb.bak` 是更早的 1 GiB 原版，不是当前 dtb 的备份**，回退时不能用它。回退用 `orig.dtb`（或 `*.pre-ion12`），脚本里按哈希校验。
3. **别用官方 `hb_switch_ion.sh`**：论坛反馈 `bpu_first`/`default` 在部分板子上让 CPU 内存异常或恢复失败，`default` 还会把 ION 恢复成 1 GiB 导致模型全加载不上。我们用自己备份、校验过的 dtb。
4. **绝不读 `/sys/kernel/debug/ion`**：读取会让这块板的内核崩溃重启。占用观测只用 `/proc/<pid>/fdinfo` 和 `/proc/bootloader_log`；探测脚本里连注释里的 debugfs 都先查过。
5. **12 GiB 是整个 ION**，CPU 侧只剩约 11.5 GiB 且没有 swap。重启前核对过：不算缓存的实际占用约 7.4 GiB，改后可用约 4 GiB，要持续留意 mongod（约 1.2 GiB）、ai-agent、ai 服务。
6. 之后的系统升级或 `hobot-*` 软件包更新**可能覆盖 dtb**，需要重新应用（具体哪个包会覆盖未验证）。

### 救援与串口

7. **重启前必须先接串口**：这是 ssh 起不来时能在 U-Boot 里直接恢复的唯一办法；DFU 路线在这块板上没演练过。
8. **串口参数是 921600 8N1**（内核命令行 `console=ttyS0,921600n8`），用 115200 只会看到乱码。本机 CH340 适配器出现两个口（COM5、COM7），**只有 COM5 有输出**，COM7 是空的。板子的 USB 调试口会同时识别成 ADB 设备。
9. 抓日志程序只读不写；重启过程中适配器由 PC 供电，不会掉线，能完整抓到 BL31、OP-TEE、内核启动到登录提示。
10. 官方恢复梯度：ssh 恢复 dtb → 串口 U-Boot / fastboot 刷 `boot` 分区 → DFU 只刷 `boot` → 整包刷（会清空 eMMC 上没备份的内容）。`E:\rdk\RESCUE.md` 有完整步骤。拨码位置对 S100P 和 12 GB 版没核实过。

### 脚本与环境

11. **从 Windows 传上板的脚本一律先 `sed -i 's/\r$//'`**，Python 在 Windows 上 `write_text` 默认写 CRLF，会让整个文件显示成全文差异。
12. 经 Git Bash 的 ssh 命令：heredoc 用单引号分隔，路径以 `/` 开头的参数会被转成 Windows 路径；不要用 `sleep` 串联等待，改用后台任务。
13. `ion12_verify.sh` 起初会因为"还有服务没回来"误报失败——重启后服务是陆续起来的，现在最多等 120 秒，以重启前正在运行的服务清单为准。
14. 板上 `dmesg | grep oops` 会命中 `ramoops` 的正常启动信息，别当成故障。
15. **硬件回归会把根分区写满**：`test_vpu.py`、`test_jpu.py` 在 4K 下每次把解码出的整段帧写进 `test/results/<时间戳>-vpu|jpu/`（约 1.5 GiB 一次），两轮共约 6.5 GiB，跑完根分区 100%、剩余 0。这次实际后果：参数库 postgres 容器因写不了 `postmaster.pid` 反复启动失败约 10 分钟（本地时间约 11:55～12:07），rsyslog 丢了一批 syslog；清出空间后 postgres 自动做崩溃恢复并正常接受连接，其余服务没有掉线。现在 `hwtest_ion12.sh` 每项跑完就把 `result.json` 和 `report.md` 转存到 SSD 并删掉原目录；跑之前先看 `df -h /`，剩余不足 8 GiB 不要跑。2026-10-30 已把 `test/results` 里大于 10 MB 的 20 个结果目录归档到 `/mnt/ainvr-ssd/test-results-archive/20261030/`（原位留软链接），`test/build`（1.5 GiB）整体搬到 `/mnt/ainvr-ssd/ainvr-tests/build-20261030` 并留软链接（脚本 `emmc_offload.sh`：先复制、逐项比对一致后才删原件），根分区剩余从 4.7 GiB 回到 11 GiB（76%）。

### 验证方法（最容易得出错误结论的地方）

16. **分配器不是"先填 pool、满了再用 carveout"**：默认标志下第一块缓存分配就落在 carveout。所以"先分配到 pool 满"逼不出 carveout 使用，结论会是假阳性（第一版测试就因此输出"PASS"，但模型其实仍在 pool 里）。正确做法是把其他堆占满、只留 carveout（`ion_prefill_model_test.py`），并量出模型占用了多少 carveout。
17. **`ion_model_spill_test.py` 测不出溢出**：同一个模型文件的多份拷贝共享权重，120 份只占 75 MiB。别用它下结论。
18. 板上 BPU 库的分配失败日志会刷满 **stdout**，把汇总挤掉。探测输出要先落盘再 `grep -v '^\[ERROR\]'`。
19. 第二轮硬件回归是在 pool 被占满时跑的，通过只说明"在这种压力下功能正常"，**没有直接观察每个测试的缓冲区落在哪个堆**，不要写成"VPU/JPU 已证明可访问 36 位以上地址"。

### 软件预算

20. 预算要用 **pool + carveout**（`HB_MEM_USAGE_PRIV_HEAP_2_RESERVED` 加 `HB_MEM_USAGE_PRIV_HEAP_RESERVED`）= 12160 MiB。**cma 的 128 MiB 不要计入**，内核驱动要用它。
21. 原来的 `ReadBpuReservedPoolBytes()` 只读 pool，若不改，软件会一直按 7680 MiB 准入，白白浪费新增的 4480 MiB。
22. **llm-service 在板上编译需要 `cargo`，板上没装**：复用现成的 `/mnt/ainvr-ssd/llm-build/ainvr/rust/release/libtokenizers_c.a`，复制到新构建目录的 `rust/release/`（`cp -p` 保时间戳），配置时加 `-DCARGO_EXECUTABLE=/bin/true` 跳过 Rust 步骤。
23. **`llm_residency_lock` 测试在板上本来就会失败**：它降权成普通用户运行探针，而 `/mnt/ainvr-ssd` 权限是 `0700` 进不去；挪到 `/tmp` 后改动前的源码也失败（`reservation_write_failed`）。这是环境问题，与预算常量无关，别被它带偏。
24. 编 search-service 带真 BPU 适配要加 `-DAINVR_SEARCH_WITH_BPU_TEXT=ON`，它依赖 `out/search-tokenizer-software`，**清理 `out/` 时不要删这个目录**。

## 4. 原理：U-Boot 如何决定 ION 的大小和位置

来源：官方 BSP 源码 `source/bootloader/uboot/arch/arm/mach-hobot/super/fdt_setup.c` 的 `super_setup_cma_size()`（`platform_source_code_20260330144014.tar.gz`，PC 上解压在 `D:\code\s100-bsp-4.0.5\`）。板上启动日志里的 `alloc_ion_pool/carveout/cma ... @地址` 与这份源码的 printf 格式一致。

- **大小**：默认取 dtb `reserved-memory/{ion_reserved,ion_carveout,ion_cma}` 节点 `reg` 的大小字段；可被 U-Boot 环境变量 `ion_reserved_size`、`ion_carveout_size`、`ion_cma_size` 覆盖（板上这些变量都没设）。
- **位置**：依次遍历内存段（跳过 2 GiB 以下的 bank0），每段里先放 pool、再 carveout、再 cma；某个 heap 放不下就留给下一段。每个 heap 必须整块放进同一段，所以 pool 最大不超过单段 8 GiB，但三个 heap 可以分布在不同段。dtb 里的起始地址不参与。
- **物理内存分段**：bank0 `0x80000000` 2 GiB；bank1 `0x400000000` 8 GiB；bank2 `0x800000000` 8 GiB；bank3 `0xC80000000` 6 GiB。
- **所以**：把 carveout 设为 4480 MiB 后，bank1 放完 7680 MiB 的 pool 只剩 512 MiB，装不下，carveout 落到 bank2 起点 `0x800000000`；cma 128 MiB 仍放在 bank1 剩余空间（`0x5e0000000`）。
- 之前认为的"总量封顶约 8190 MiB"只对 **pool 单个 heap** 成立，不是 ION 总量上限。
- **硬件访问**：BPU、PYM、GDC、显示的设备树节点有 `iommus`（SMMU），物理地址落在哪一段对它们透明。JPU、VPU、ISP 是否走 SMMU 没查到。
- 其他固定预留（不在 ION 内，本方案不改）：`bpu_region` 96 MiB、`vpu_ddr_reserved` 64 MiB、`dsp0_ddr_reserved` 64 MiB、OP-TEE 128 MiB、MCU 核间通信约 32 MiB。

## 5. 现成工具

板上 `/mnt/ainvr-ssd/dtb-work/` 与 `/mnt/ainvr-ssd/search-models/scripts/`，源文件在 PC `D:\AINVR\work\scripts\`。

| 脚本 | 作用 |
|---|---|
| `make_ion12_dtb.sh` | 从当前 dtb 生成只改 carveout 大小的 `patched.dtb` |
| `ion12_apply.sh` | 校验后原子替换 dtb、停服务；**不重启**；必须带 `CONFIRM=yes-user-approved-ion12` |
| `ion12_rollback.sh` | 还原原版 dtb（按哈希校验）；不重启 |
| `ion12_verify.sh` | 重启后只读检查，逐项 PASS/FAIL，证据写入 `after_*` |
| `ion_spill_test_layout.py` | 按启动日志里的真实布局分配到失败并归类 |
| `ion_prefill_model_test.py` | 占满其他堆，强制模型走 carveout，比对输出 |
| `ion_hold_pool.py` | 占满 pool 并等待，供硬件回归第二轮使用 |
| `hwtest_ion12.sh` | 硬件回归两轮，结束自动恢复服务 |

回滚：`bash /mnt/ainvr-ssd/dtb-work/ion12_rollback.sh` 后重启；板上 `/boot/hobot/rdk-s100p-v1p0.dtb.pre-ion12` 是原件，原始分区备份在 `/mnt/ainvr-ssd/backups/pre-ion12-raw-20261029/`，PC 上在 `D:\AINVR\backups\pre-ion12-raw-20261029\`。

## 6. 软件预算常量（2026-10-30）

已改源码（板上 `/home/sunrise/ainvr`，**未提交**）：

| 位置 | 改动 |
|---|---|
| `shared/cpp/bpu_reserved_pool.hpp` | `ReadBpuReservedPoolBytes()` 改为 `ReadBpuIonBudgetBytes()`，返回 pool + carveout，读 SDK，没有任何写死上限；carveout 读不到时抛 `memory_pool_unknown` |
| `search-service/src/bpu_text_encoder.cpp` | 删除写死的 `kMaximumS100Pool` 7680 MiB 和对应的参数上限检查 |
| `search-service/src/bpu_text_encoder.hpp`、`bpu_vision_encoder.hpp` | `total_bytes` 默认值由 7680 MiB 改为 `UINT64_MAX`（可选上限），实际预算取"SDK 读数与上限的较小值" |
| `search-service/src/bpu_vision_encoder_contract.cpp` | 去掉 `total_bytes` 不得超过 7680 MiB 的校验 |
| `llm-service/src/service.cpp`、`search-service/src/bpu_vision_encoder.cpp`、两个 `test/search` 探针 | 改用 `ReadBpuIonBudgetBytes()` |
| `search-service/tests/bpu_vision_encoder_contract_test.cpp` | "7681 MiB 被拒绝"改为"12288 MiB 被接受" |

验证：
- 真板上新函数读数为 **12160 MiB**（7680 + 4480）。
- search-service（含真 BPU 适配）编译通过，29 项测试 0 失败，5 项因缺条件（如 Mongo）跳过。
- llm-service 编译通过；`llm_residency_lock` 失败属环境问题，见第 3 节第 23 条。
- 单元测试用的构建目录 `/mnt/ainvr-ssd/build-ion12/{search,llm}` 可以删。

### 部署（2026-10-30 12:20）

只替换了 `ainvr-search` 和 `ainvr-llm` 两个服务的程序，没有走整套发布流程（`deploy_ptz_release.py --profile search` 会同时更换 AI、控制台前后端和 helper 并重启 AI，范围大得多）。

1. 在现网同一套已配置好的构建目录里增量编译：search 用 `out/search-text-integration`，llm 用 `out/llm-search-software/native`（Release，search 带 `AINVR_SEARCH_WITH_BPU_TEXT=ON`），保证口径和现网一致。运行时依赖只有 `/usr/hobot/lib`，没有指向构建目录。
2. 部署脚本 `deploy_ion_budget.sh`（板上 `/mnt/ainvr-ssd/dtb-work/`）：
   - 先把现网程序和启动配置备份到 `/mnt/ainvr-ssd/ainvr-rollback/{search-service,llm-service}/<时间戳>/`（`binary`、`managed/`、`backup.json`），校验哈希；
   - 停两个服务，用 `install` 写 `.new` 再原子 `mv`，校验哈希，再启动；
   - 起不来或健康检查连续不过则自动还原备份并重启；
   - 成功后每个服务只保留最新 3 份备份。
3. 结果：search `e15d770c…` → `54de6ec7…`，llm `81edd9eb…` → `8b0a5c69…`；两个服务一次启动成功、重启次数 0，日志无错误；`/run/ainvr/bpu-reservations.json` 里两者都是协议 3、状态 `loaded`（search 498 MB，llm 5.5 GB）。

回滚：把对应备份目录里的 `binary` 拷回 `deploy/s100p/bin/ainvr_{search,llm}_service`（同样先写 `.new` 再 `mv`），重启两个服务。

注意：
- 状态接口 `/v1/status` 需要服务密钥，这次没有读取密钥，所以**没有直接看到准入预算的数字**；验证依据是新程序能正常通过准入并加载模型（读不到 carveout 会直接抛 `memory_pool_unknown` 起不来），以及同一函数在同环境读出 12160 MiB。
- 这次是单独换了两个程序，整套发布流程的回滚保护会比对"程序哈希是否还是它部署的那份"，下次用它回滚上一次事务时可能因此拒绝（保护性拒绝，不会破坏现网；未实测），需要先对账。正向发布新版本不受影响的判断也未实测。
- 源码改动还在工作区没提交，下一次用整套发布流程出包会把它们带进去；提交由你决定。

## 7. 风险与未验证项（如实）

1. JPU / VPU / ISP 对 `0x800000000` 以上地址的支持：硬件回归通过，但没有逐个确认缓冲区落在哪个堆。`vdsp` 启动日志显示 DMA mask 32bit，DSP 相关功能没测。
2. 摄像头采集链路（MIPI → ISP → YNR → PYM）本轮没测，测试里只跑了合成 RAW 的 ISP 项。
3. 板上 U-Boot 二进制与 BSP 源码是否同版本：只凭日志格式推断。
4. A/B 槽：`boot_b` 是 2025-10 的出厂旧内核，U-Boot 是否会在 A 槽起不来时自动切换**没验证过**，不要依赖。
5. 启动代码在 NOR 闪存，没有整块镜像；官方包里的 `miniboot_flash.img` 是出厂内容，不含板子独有数据（是否存在没核实）。
6. S100P 与 12 GB 版 S100 的拨码位置是否与官方 S100 文档一致，未核实；本机 XBurn 没有实际识别过这块板子。

## 8. 如果将来换成 12G 版 S100（非 P）

同一套 U-Boot 逻辑通用，但 12G 机型每个大段只有 4 GiB（2 + 4 + 4 + 2 GiB），pool 最大约 4 GiB，且总内存只有 12 GB，给 ION 多了 CPU 就紧；官方脚本对 S100 的 `bpu_first` 档也给了风险提示。应优先选 24G 版本，不要指望靠调 ION 把 12G 版调到够用。镜像与 S100P 共用一套，恢复资料在 `E:\rdk\`。

## 9. 参考

- 官方硬件文档（HBMEM 使用指南 / 硬件信息）：<https://d-robotics.github.io/rdk_doc/rdk_s/Advanced_development/linux_development/driver_development_s100/driver_hbmem/s100_hbmem_hardware>
- 官方论坛《RDK S 系列设备树内存分配调整指南》：<https://forum.d-robotics.cc/t/topic/31229>
- BSP 源码下载：旧站资源中心 `https://developer-legacy.d-robotics.cc/resource`（需登录），条目"RDK S100 资料汇总 4.0.5版本"；新站 S100 版本是 `RDKS100-V4.0.5_20260507`，比本板（构建于 2026-03-19）更新，匹配性以旧站 4.0.5 版本为准。下载的压缩包末尾被截断，`source/bootloader` 部分完整。
