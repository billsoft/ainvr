# 智能搜索模型：Qwen3-VL-Embedding-2B（全 BPU）

当前生产状态：2026-11-02 晚已按用户决定换回 SigLIP2 Base 256（768 维，siglip2-base-full-int8），搜索数据已清空重积；本包保留为可选模型（切换用 deploy-package/search_fresh_model_cutover.mjs，两个方向都支持，切回 SigLIP2 时恢复默认采样节奏与 10 万样本上限）。
历史：2026-11-02 曾切换上线本模型（旧 768 维搜索数据已按授权清空，从零重新积累）。同样本并排对比未显示它在检索结果上明显优于 SigLIP2，所以产品默认回到 SigLIP2。
本文是该模型的唯一说明；SigLIP 系列的历史记录见 `AI-SEARCH-MODELS-HBM.md` 与 `SEARCH-SO400M-FRESH-CUTOVER.md`。
指标是"板上结果与原版 BF16 向量的一致度"，不是现场检索准确率。

## 1. 结构

```
 摄像头帧 ─ ai-service 采样(GLES/JPU 裁剪缩放) ─┐
                                               ├─ Qwen3VlEmbedder（唯一权重持有者，ai-service 进程内）
 文本查询 ─ search-service ── 0600 本地套接字 ──┘     视觉4组 + 文本4组(7层，s1+s256) + 输出头，共 9 个 O2 HBM
 向量(2048 维，L2 归一化) ─ search-service ─ Mongo(search_samples) ─ 内存精确余弦索引 ─ 控制台
```

- **权重只加载一份**：图片向量与查询向量共用 28 层文本解码器，所以由 ai-service 独占全部 9 个 HBM，search-service
  不再加载文本塔。文本查询走 `/run/ainvr/search-embed.sock`（目录 0700、套接字 0600、同一用户，不另设令牌）。
- **按需加载、无人使用即释放**（`ai-service/src/output/search_qwen_runtime.*`）：
  - 谁先要谁加载：search-service 周期性发 `ensure`（每 20 秒，查询本身也算），或采样会话获取。
  - 没有持有者约 90 秒后释放 ION（约 3.75 GB）。关闭智能搜索后不占显存。
  - 这解开了一个循环依赖：采样租约要等模型 pin，而 pin 要先有可用的文本编码器。
- 查询优先于采样：每次 BPU 调用之间让出，文本查询约 0.55 秒（采样并发时约 0.8–1.9 秒）。
- 主机侧（CPU，仅数据排布）：切 patch、BF16 词嵌入行查表(622 MB mmap)、MRoPE、KV 窗口/掩码排布、L2 归一化；
  C++ 实现在 `ai-service/src/embedding/`，BPU 多 program 句柄在 `ai-service/src/platform/bpu_pack.*`
  （一个 HBM 里的 s1/s256 共享权重，避免加载两次）。

## 2. 模型包

`ai-service/models/search/`（系统盘，约 3.5 GB）：

| 路径 | 内容 |
|---|---|
| `hbm/qwen3vl-emb-{vis-0..3,txt-0..3,head}.hbm` + `.hbm.ainvr.json` | 9 个 O2 包与契约（程序名、张量形状、哈希） |
| `data/qwen3vl-embed-tokens-bf16.bin` | 词嵌入表（151936×2048，BF16） |
| `data/qwen3vl-vision-rope.f32`、`data/qwen3vl-prefix-kv.f32` | 视觉 RoPE；第 0 个 token（注意力汇聚点）的预先算好的 K/V |
| `tokenizers/qwen3vl-vocab.json`、`qwen3vl-merges.txt` | 字节级 BPE |
| `SHA256SUMS.txt` | 全部哈希（与旧包共用一个清单） |

- 包 ID `qwen3vl-embedding-2b-o2`，向量空间版本 = 清单与输入规格的哈希（`search-v1-<sha256>`）。
- 校验：加载方（ai-service）完整哈希（约 16 秒冷读）；只要身份的一方（search-service）用清单加大小/时间戳校验，结果同一个版本号。
- 组装脚本：`test/model_conversion/search/make_qwen3vl_embedding_package.py`（板上以 root 运行）。
- ION 预留 3.75 GB 是**估算**（HBM 文件 2.94 GB 实测 + 程序张量约 0.63 GB 按形状推算），不是 ION 实测。
  登记目录 `/run/ainvr/bpu-reservations.json` 中以 `search-service` 名义登记（原有的 0.5 GB 文本塔与 0.1 GB 视觉塔记录随旧模型消失）。

## 3. 输入约定（属于向量空间，改动即换空间）

- 模型输入固定 896×448 RGB，`(x−127.5)/127.5`。送入模型的区域与证据 JPEG 的源矩形完全相同，不多不少。
- 区域宽高比在 1.6–2.5 之间直接拉伸；否则 letterbox，空白填 127.5（归一化后为 0），保持目标比例。
- 缩放滤波：两个方向都缩小用 Area（有抗锯齿），否则 Bicubic。纯 Bicubic 在 4K/8K 大幅缩小时 GPU 上没有抗锯齿，
  与有抗锯齿参考的余弦只有 0.87–0.89；混合规则下合成大图 0.966、1280 场景 0.992、目标裁剪 0.992。
- 提示词：图片用 "Represent the user's input."；查询用 "Retrieve images or text relevant to the user's query."，
  之后固定的聊天模板与 `<|endoftext|>`。用户文本一律按普通文本处理，不解析其中的特殊标记。
- 查询总长不超过 320 个 token（页面限制 256 字，中文每字至多一个 token）。

## 4. 实测结果（O2，板上，对原版 BF16）

| 项 | 结果 |
|---|---|
| 最终集 226 项向量余弦 | 查询均值 0.998 / 最小 0.995；图片均值 0.994 / 最小 0.968 |
| 文搜图 top10 与 BF16 重合 | 0.87 |
| C++ 运行时对 Python 参考 | 查询余弦 ≥0.99997；图片均值 0.993（与 Python 对 BF16 的 0.993 相同，差异是浮点噪声级） |
| 速度 | 图片 1.51 秒（视觉 0.51 + 文本 1.0）；查询 0.54 秒（生产 AI 暂停时） |
| GLES 路径 vs PIL 参考（50 张真实/合成 JPEG） | 场景 0.992、目标 0.992、超大图 0.966 |
| 真机模拟流（1080p 走廊视频推到 `/live/8k`） | 45 秒内写入 4 条、3 分钟 27 条；2048 维、范数 1、证据 `model_input` 如实 |
| 真实样本上的相似度尺度 | 贴切查询 0.33–0.47，无关查询 0.25–0.27，随机图文 ≈0.17 |

## 5. 配置与页面

- 默认包改为 `qwen3vl-embedding-2b-o2`（迁移 `027_search_qwen3vl_default.sql` 只推进"从未改动过"的 020 种子；
  已被管理员改动、启用或带凭据的安装不受影响）。
- `limits.max_samples` 默认 60000：2048 维向量 8 KB/条，内存精确投影上限由 64M 提到 128M floats（`index_limits.hpp`，约 512 MB），
  最多 62,500 条；`max_bytes` 默认 1 GiB 能存的天数相应缩短，配置页如实显示条数与字节。
- 页面"最低相似度"：默认 0.25，范围 0–0.50，步长 0.01（输入框 `step=any`，可填任意小数）。分数不是概率，结果始终按相似度降序。
  这个默认值用 COCO 评测集和 27 条模拟样本标定，**现场数据积累后需要重新标定**。
- 采样吞吐：每张图片约 1.5 秒，全局同时在途的采样任务有上限（`SearchWorkBudget`），满了走既有的 延期/busy/capacity 并如实记入覆盖缺口，
  不抽样伪装完整覆盖，也不改检测帧率与 AI 识别归档。

## 6. 数据结构

- **表结构没有变化**。Mongo `search_samples` 的向量自带 `dimensions`、`vector_format=f32le`，索引与维数无关；PG 的
  `search_index_shards.model_version`、`search_runtime_state.active_model` 与模型无关。
- 切换时清理的只有搜索派生数据（旧 768 维）：Mongo 的 `search_*` 集合、SSD 索引分片、PG 的 `search_jobs`/`search_index_shards`/
  `search_runtime_state`。AI 识别归档、录像、告警、通道/热区/计数配置一律不动。

## 7. 运维

切换（强制显式 from/to；先 `--check`）：

```sh
AINVR_FRESH_AI_BINARY=out/build/<ai-build>/ainvr_s100p_control_service \
AINVR_FRESH_SEARCH_BINARY=out/build/<search-build>/ainvr_search_service \
AINVR_FRESH_READY_TIMEOUT_MS=600000 \
setsid nohup node deploy-package/search_fresh_model_cutover.mjs --check|--apply \
  --from siglip2-base-full-int8 --to qwen3vl-embedding-2b-o2 > cutover.log 2>&1 &
```

- 必须脱离终端运行（`setsid nohup`）；失败时脚本会停掉 ai 和 search（既有的"失败即保持搜索关闭"策略）。
- 回退 = 反向切换（`--from qwen3vl-embedding-2b-o2 --to siglip2-base-full-int8`），同样清空再积累，不能混用两个向量空间。
  旧二进制备份在 `/mnt/ainvr-ssd/ainvr-rollback/{ai-service,search-service}/<时间戳>/`，脚本只接受 `out/` 下的候选二进制，需先复制过去。
- 真机验证（须先暂停生产 AI，只用保护脚本）：`ainvr_qwen3vl_vision_probe`（JPU 解码 → GLES → 嵌入，对 PIL 参考算余弦）、
  `ainvr_qwen3vl_embed_cli`（文本/图片向量、分词黄金对拍）。
- 软件测试：`ainvr_qwen3vl_embedding_test`（分词黄金、主机排布、本地套接字、输入规则）、`ainvr_qwen_runtime_host_test`
  （按需加载/共享/保活/失败重试）、`search-service` 的 `model_package`/`remote_text`/`runtime_text`/`vector_index`、
  `test/search/search-fresh-model-policy.test.mjs`、前端 Search/配置页测试、PG 迁移 027 测试。

## 8. 限制与待办

- 采样端只支持固定 896×448 输入；原生分辨率与其他尺寸未支持。
- 切 patch 与词嵌入查表在 CPU（只做数据排布与行查表）；上 BPU/PYM 属后续优化。
- 图片余弦最小值 0.968，低于最初自设的 0.97 门槛 0.002；个别图片的视觉塔量化可再看。
- 分词：用户文本不做 Unicode NFC 归一化（浏览器输入通常已是 NFC）；极少数非规范输入会得到与 HF 略有不同的 token。
- 外观探针（轨迹槽位替换）的阈值是按 SigLIP 距离尺度调的，每次探针现在是一次约 1.5 秒的完整嵌入，需观察槽位替换率与探针次数。
- 本次联调使用 1080p 模拟流，没有真实 8K/4K 摄像机帧；真实相机上线后需要看覆盖缺口与分数分布。
