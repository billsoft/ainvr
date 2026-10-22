# 禁止读取 `/sys/kernel/debug/ion`

2026-10-22，在本板内核（6.1.158-rt58-DR-4.0.5）上读取 `/sys/kernel/debug/ion/heaps/cma_reserved` 触发了内核崩溃并自动重启。
调用栈：`ion_heap_show → ion_debug_heap_show → traverse → seq_lseek`，随后 `Kernel panic - not syncing: Oops`。证据：`test/results/llm-service-development/kernel-incident-20261022/`。

## 规则
- 整个 `/sys/kernel/debug/ion/` 目录禁止读取：不论 `cat`、`head`、`tail`、`less`、Python/awk 顺序读取，也不论单次还是轮询。顺序读取过去没出事，不代表安全。
- 生产服务的 systemd 单元用 `InaccessiblePaths=/sys/kernel/debug` 屏蔽。
- `test/` 下仍有约 100 个早期实验脚本（主要是 LocateAnything 系列、`locateanything_process_memory_v*.py`）读取该目录，**全部不得再运行**；需要复用时先把内存采样改为下面的替代方式。

## 替代方式
| 需要 | 做法 |
|---|---|
| 某进程持有多少 ION | 读 `/proc/<pid>/fdinfo/<fd>`：链接目标为 `/dmabuf:` 且 `exp_name: ion` 的条目，按 `ino` 去重累加 `size`。这是**下限**（不含驱动内部分配），只用于展示与归因 |
| 池总量 | 官方接口 `hb_mem_get_heap_size` |
| 能否加载大模型 | 不估算剩余量：共同预留锁 + 静态预算 + “加载后试分配余量”，见 `docs/S100P-LLM-SERVICE-DESIGN.md` §7 |
