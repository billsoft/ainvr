# 把 BPU 可用内存扩到 12 GiB：方式与原理（方案，未执行）

日期：2026-10-28。对象：S100P（24 GiB 内存，系统 4.0.5，内核 `6.1.158-rt58-DR-4.0.5-2603191535`）。
**状态：只做了源码与板上只读分析，板子上没有改任何东西。** 实施需要停机重启，由负责人批准后再做。

## 1. 结论

- 不需要重刷固件，也不需要改 U-Boot 代码：只需把 `/boot/hobot/rdk-s100p-v1p0.dtb` 里 `ion_carveout` 的**大小**从 128 MiB 改为 **4480 MiB（`0x118000000`）**，重启。
- 结果：ION 总量 = pool 7680 + carveout 4480 + cma 128 = **12288 MiB（正好 12 GiB）**；Linux 可用内存约从 15895 MiB 降到 **11543 MiB（约 11.3 GiB）**。
- 这里的"12 GiB"是**整个 ION**（BPU、VPU、JPU、PYM、GDC 等共用），不是 BPU 专用。
- 大 carveout 能否被 BPU 加载模型真正用到、JPU/VPU/ISP 能否访问它，**都还没有实测**，见第 6 节。

## 2. 当前板上的内存布局（实测）

物理内存 24 GiB，分四段（启动日志 `ddr_bank[i]`）：

| 段 | 起始 | 大小 |
|---|---|---:|
| bank0 | `0x80000000` | 2 GiB |
| bank1 | `0x400000000` | 8 GiB |
| bank2 | `0x800000000` | 8 GiB |
| bank3 | `0xC80000000` | 6 GiB |

当前 ION（运行中的设备树，即 U-Boot 修正后的结果）：

| heap | 起始 | 大小 | 说明 |
|---|---|---:|---|
| `ion_reserved`（pool） | `0x400000000` | 7680 MiB | BPU 的主池，`HB_MEM_USAGE_PRIV_HEAP_2_RESERVED` |
| `ion_carveout` | `0x5e0000000` | 128 MiB | |
| `ion_cma` | `0x5e8000000` | 128 MiB | |

注意 `/boot` 里 dtb 文件写的 carveout 起始是 `0x800000000`、cma 是 `0xC80000000`，**运行时却是 `0x5e0000000`、`0x5e8000000`**：dtb 里的起始地址被 U-Boot 忽略了。这一点是之前排查的关键。

其他固定预留（不在 ION 内，本方案不改）：`bpu_region` 96 MiB、`vpu_ddr_reserved` 64 MiB、`dsp0_ddr_reserved` 64 MiB、OP-TEE 128 MiB、MCU 核间通信约 32 MiB、PCIe BAR 与固件区若干。

## 3. 原理：U-Boot 如何决定 ION 的大小和位置

来源：官方 BSP 源码 `platform_source_code_20260330144014.tar.gz`（RDK S100 资料汇总 4.0.5 版本，下载自旧站资源中心，PC 上解压在 `D:\code\s100-bsp-4.0.5\`），文件
`source/bootloader/uboot/arch/arm/mach-hobot/super/fdt_setup.c`，函数 `super_setup_cma_size()`。板上启动日志里的 `alloc_ion_pool/carveout/cma ... @地址`、`Set Reserved Mem [...] Size to ...` 与这份源码的 printf 格式一致（版本一致性只凭这一点推断，没有逐字节比对）。

**大小从哪来：**
1. 默认取 dtb 里 `reserved-memory/{ion_reserved,ion_carveout,ion_cma}` 节点 `reg` 的**大小**字段。
2. 可被 **U-Boot 环境变量覆盖**：`ion_reserved_size`、`ion_carveout_size`、`ion_cma_size`（十六进制，`env_get_hex`）。

**位置怎么排（首次适配）：**
- 依次遍历内存段，**跳过 2 GiB 以下的 bank0**。
- 在每个段里，`reserved_size` 从 0 开始：先试放 pool（放在段起点），再试放 carveout（紧跟其后），再试放 cma；某个 heap 放不下就留给下一个段（下个段从起点重新排）。
- 每个 heap 必须**整块放进同一个段**（所以 pool 最大不超过单段 8 GiB），但三个 heap **可以分布在不同的段**。
- 排好后 U-Boot 把大小和起始地址写回设备树传给内核；dtb 里写的起始地址不参与。

**据此推出：**
- 之前认为的"总量封顶约 8190 MiB"只对 **pool 单个 heap** 成立，不是 ION 总量上限。
- 把 carveout 设为 4480 MiB：bank1 放完 pool（7680 MiB）后只剩 512 MiB，装不下 4480 MiB，carveout 落到 **bank2 起点 `0x800000000`**；cma 128 MiB 仍能放进 bank1 剩余空间。
- 官方论坛的 `hb_switch_ion.sh bpu_first` 档（pool/carveout/cma 各数千 MiB）会被排到三个不同的段，CPU 内存只剩约 3～4 GB，与论坛用户的反馈一致，说明这套机制在实际板子上就是这样工作的。

**硬件为什么不怕起始地址变化：** 设备树里 BPU、PYM、GDC、显示子系统节点都有 `iommus` 属性，板上有 SMMU。SMMU 是给外设用的"地址翻译表"：外设拿到的是设备虚拟地址（IOVA），内核在分配缓冲时把"IOVA → 真实物理地址"写进页表，物理地址在哪个段对这些外设是透明的。JPU、VPU、ISP 是否也走 SMMU **没有查到**（VPU 另有一块固定的低地址 64 MiB 工作区，不在 ION 内）。

## 4. 实施步骤（需批准后执行，会停机）

停机内容：所有服务（录像、AI、复审）重启期间中断，约几分钟。

1. **确认备份**：`/mnt/ainvr-ssd/backups/pre-ion12-20261028/`（含 `boot`、`partitions`、`repo`、`rootfs-config`，有 `SHA256SUMS.txt`）和 PC `D:\AINVR\backups\pre-ion12-20261028`；当前 dtb 副本 `/mnt/ainvr-ssd/dtb-work/orig.dtb`（sha256 前缀 `da066abd`，与 `/boot/hobot/rdk-s100p-v1p0.dtb` 一致）。
2. **准备好的 dtb**：`/mnt/ainvr-ssd/dtb-work/patched.dtb`（sha256 前缀 `263fc72a`）。它只改了 `ion_carveout@800000000` 的 `reg`：`8 0 1 18000000`（大小 `0x118000000` = 4480 MiB，起始字段被 U-Boot 忽略）；pool（`4 0 1 e0000000`）和 cma（`c 80000000 0 8000000`）不变。生成脚本 `D:\AINVR\work\scripts\make_ion12_dtb.sh`。
3. 停相关服务（`ainvr-ai`、`ainvr-llm` 等），把 `patched.dtb` 拷成 `/boot/hobot/rdk-s100p-v1p0.dtb`，`sync`，重启。
4. **启动后立即验证（只读）**：
   - `/proc/bootloader_log` 里应出现 `alloc_ion_pool 0x00000001e0000000 @0x400000000`、`alloc_ion_cma 0x0000000008000000 @0x5e0000000` 一类，以及 **`alloc_ion_carveout 0x0000000118000000 @0x800000000`**。
   - `/proc/device-tree/reserved-memory/ion_carveout*/reg` 读出的大小为 `0x118000000`。
   - `MemTotal` 约 11543 MiB（现在 15895 MiB）；`/proc/iomem` 中 `800000000` 起有预留。
5. **功能验证**：解码（VPU）、JPEG 编码（JPU）、金字塔缩放、GDC 投影、摄像头采集（如果用）各跑一遍，无分配失败、无花屏；再做 BPU 溢出测试（见第 6 节第 1 条）。
6. 盯 CPU 侧内存：MongoDB、`ai-service`、`llm-service`（Qwen 复审）、控制台后端。

**回退：** 把 `orig.dtb` 拷回 `/boot/hobot/rdk-s100p-v1p0.dtb`，`sync`，重启。若 dtb 写坏导致起不来，需要串口、fastboot 或烧录工具恢复；板子是 A/B 双槽，但 dtb 在 `boot_cur` 里，U-Boot 是否会自动回退到另一槽**没有验证过**，不要依赖。

**备选做法（不改 dtb）：** 在 U-Boot 里设置 `ion_carveout_size=0x118000000` 并保存。板上 `ubootenv` 分区（`/dev/mmcblk0p3`，1 MiB）目前是空的，没有 `fw_setenv`，只能在串口 U-Boot 控制台里 `setenv` / `saveenv`；`hobot_s100_defconfig` 中环境保存在 MMC（`CONFIG_ENV_OFFSET=0x280000`，大小 `0x100000`），板上实际配置没有核对。比改 dtb 难，没有额外好处，不推荐。

## 5. 软件侧需要配套修改（硬件改完之后才做）

当前代码把"BPU 可用内存"等同于 pool：
- `shared/cpp/bpu_reserved_pool.hpp`：`ReadBpuReservedPoolBytes()` 只查 `HB_MEM_USAGE_PRIV_HEAP_2_RESERVED`（pool）的大小。
- `search-service/src/bpu_text_encoder.cpp`：`kMaximumS100Pool = 7680 MiB` 写死。
- `shared/cpp/bpu_coexist_reservation.hpp`（协议 3）：`IonPolicy.pool_bytes` 是单池预算；`llm-service/src/service.cpp` 把它传进来。

carveout 扩大后，若要让准入预算反映新增空间，需要：先实测 hbmem 在 pool 满后是否真的回退到 carveout（之前在 128 MiB carveout 上测到分配会按 `cma_reserved ⇒ carveout ⇒ cma` 回退，内核做跨 heap 的分散分配），再决定把 `pool_bytes` 改成"pool + carveout"还是分别记账；`kMaximumS100Pool` 随之调整。**在实测之前不要改预算，否则可能把根本分配不到的空间当成可用。**

## 6. 风险与未验证项（如实）

1. **大 carveout 是否能被 BPU 模型加载用到**：溢出行为只在 128 MiB carveout 上测过。改完后要用一个超过 pool 剩余空间的模型实测（脚本：`ai-service/models/search/scripts/ion_coresident_test.py`、`ion_by_process.py`；溢出测试脚本在 `/mnt/ainvr-ssd/search-models/scripts/ion_spill_test.py` 等）。
2. **JPU / VPU / ISP 能否访问第 2 段**：没有证据。PYM、GDC、BPU、显示走 SMMU 是查到的；官方 `bpu_first` 脚本和厂商的默认 4G 非 interleave 布局（代码里 `DEFAULT_*_FOR_4G_NON_INTERLEAVE`，carveout 在 `0x800000000`、cma 在 `0xC80000000`）把 heap 放在第 2、3 段，是间接依据。
3. **板上 U-Boot 二进制与 BSP 源码是否同版本**：只凭日志格式推断。
4. **CPU 内存减少约 4.3 GiB**：现网 Linux 可用内存余量要重新核对。
5. 之后的系统升级或 `hobot-*` 软件包更新可能覆盖 dtb，需要重新应用（具体哪个包会覆盖未验证）。
6. 绝不读取 `/sys/kernel/debug/ion`（读取曾导致内核崩溃）；占用观测用 `/proc/<pid>/fdinfo` 和 `/proc/bootloader_log`。
7. 官方 `hb_switch_ion.sh` 不要直接用：论坛反馈 `bpu_first`/`default` 在部分板子上让 CPU 内存异常或恢复失败，早期版本还把 cma 范围写进了内核区。我们用自己备份和校验过的 dtb。

## 7. 如果将来换成 12G 版 S100（非 P）

同一套 U-Boot 逻辑通用，但 12G 机型每个大段只有 4 GiB（2 + 4 + 4 + 2 GiB），pool 最大约 4 GiB，且总内存只有 12 GB，给 ION 多了 CPU 就紧；官方脚本对 S100 的 `bpu_first` 档也给了风险提示。应优先选 24G 版本，不要指望靠调 ION 把 12G 版调到够用。

## 8. 参考

- 官方硬件文档（HBMEM 使用指南 / 硬件信息）：<https://d-robotics.github.io/rdk_doc/rdk_s/Advanced_development/linux_development/driver_development_s100/driver_hbmem/s100_hbmem_hardware>
- 官方论坛《RDK S 系列设备树内存分配调整指南》：<https://forum.d-robotics.cc/t/topic/31229>
- BSP 源码下载：旧站资源中心 `https://developer-legacy.d-robotics.cc/resource`（需登录），条目"RDK S100 资料汇总 4.0.5版本"；新站资源汇总页的 S100 版本是 `RDKS100-V4.0.5_20260507`，比本板（构建于 2026-03-19）更新，匹配性以旧站 4.0.5 版本为准。下载的压缩包末尾被截断，`source/bootloader` 部分完整。

## 附：2026-10-29 前期准备的结果与现成工具

以下都已完成，**板子本身未改动、未重启**。

### 已核实的事实

- 启动日志含 `uboot skip verify` 和 `skip verify boot partition`：**boot 分区（含 dtb）不做签名校验**，替换 dtb 不会被拒。
- `/boot` 是独立的 60 MB ext4 分区（`mmcblk0p12`，`boot_a`），剩余 18 MB；同尺寸替换足够。
- 磁盘为 A/B 双槽，当前运行 `_a`。`boot_b` 里是 2025-10 的出厂旧内核（4.0.4），不是当前系统的镜像；B 槽能否自动接管未验证。
- `patched.dtb` 与 `orig.dtb` 反编译后只差 carveout 的 `reg` 一行（`0x8000000` → `0x118000000`）。
- 板上 `/boot/hobot/rdk-s100p-v1p0.dtb.bak` 是更早的 1 GiB 原版，与当前运行的 dtb 不同，**回退时不要用它**。
- 启动代码在 NOR 闪存，本方案不碰它；官方恢复记录自己写明没有整块闪存的完整镜像。

### 备份

- SSD：`/mnt/ainvr-ssd/backups/pre-ion12-raw-20261029/`（U-Boot、BL31、OP-TEE、ubootenv、两个 boot 分区、eMMC 硬件 boot 分区、`/boot` 文件包、启动日志，共 259 MB，含 `SHA256SUMS.txt`）。
- PC：`D:\AINVR\backups\pre-ion12-raw-20261029\`，已校验；另含未提交改动补丁和 systemd 单元包。
- 改动前基线：同目录下 `baseline_before/`（启动日志 ION 行、free、meminfo、iomem、服务状态）。

### 现成脚本（在板上 `/mnt/ainvr-ssd/dtb-work/`，源文件在 `D:\AINVR\work\scripts\`）

| 脚本 | 作用 | 备注 |
|---|---|---|
| `ion12_apply.sh` | 校验后原子替换 dtb、停服务、落盘 | **不重启**；必须带 `CONFIRM=yes-user-approved-ion12` 才会执行 |
| `ion12_rollback.sh` | 还原原版 dtb | 不重启；ssh 可达时使用 |
| `ion12_verify.sh` | 重启后只读检查并逐项 PASS/FAIL | 等服务最多 120 秒；证据写入 `after_*` 目录 |
| `ion_spill_test_layout.py` | 分配到失败，按启动日志里的真实布局归类 | 需先停 ai、llm 服务 |

`ion12_apply.sh` 的拒绝逻辑和三个脚本的语法已测过；`ion12_verify.sh` 在当前旧布局上试跑，结果符合预期（carveout 与 MemTotal 两项 FAIL，其余 PASS）。`apply` 和 `rollback` 的实际替换动作**尚未执行过**。

### 恢复手段

- 官方 DFU+Fastboot 下载模式（拨码开关进入），专用于空板或变砖。
- 离线资料在 PC 的 `E:\rdk\`：最新镜像 `RDKS100-V4.0.5_20260507`、3 月版回退镜像、XBurn 1.2.2、驱动、`RESCUE.md`。
- S100、S100P、12 GB 版 S100 共用同一套镜像。
- 轻量恢复可只刷 `boot` 分区，不必整包刷写。
- 未验证：S100P 与 12 GB 版的拨码位置是否与官方 S100 文档一致；本机 XBurn 尚未实际识别过这块板子。
