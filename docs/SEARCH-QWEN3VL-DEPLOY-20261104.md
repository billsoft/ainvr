# 文搜换 Qwen3-VL-Embedding-2B 部署手册（2026-11-04）

目标：把智能搜索从 SigLIP2（现为 4×768=3072 浮点/条）换成 Qwen3-VL-Embedding-2B（2048 维，全 BPU）。向量空间不同，必须清空搜索派生数据重新积累。

## 0. 先知道的事
- 现在板上是 SigLIP2 + 四视图（整帧+3 个短边方块）。Qwen 包是单向量、整帧输入，**没有三方块切分**；输入固定 896×448（宽高比 1.6–2.5 直接拉伸，否则补灰边）。
- 速度：每张图约 1.5 秒（SigLIP2 约 30 毫秒），查询约 0.55 秒。采样节奏会被切换脚本抬到至少：目标 4 秒、场景活跃 20 秒、静止 60 秒、变化最小间隔 5 秒；`max_samples` 取现值与 60000 的较小者（现为 40000，不变）；`producer_queue`=1。多通道时 BPU 占用约为每路每 20 秒 1.5 秒，变化探针每次也是一次完整嵌入，上线后观察。
- 切换会短时停止 `ainvr-ai`、`ainvr-search`、`ainvr-backend`（AI 识别和控制台接口中断几分钟，最长等 600 秒）。录像、接入、告警服务不停。
- 已核对：当前部署的两个二进制与 `out/build/qwen-ai`、`out/build/qwen-search` 的构建产物哈希一致，且都含 Qwen 包代码。四视图改动后 Qwen 路径**没有在板上跑过**，所以上线后必须做第 5 节验证。
- 我已修了切换脚本：旧脚本把 SigLIP2 源维度写成 768，现在存的是 3072，直接跑会 `mixed_index_space` 失败。`--check` 已实测通过（旧样本 1139 条，1 个索引分片）。反向切回 SigLIP2 时样本上限改为 40000（原来是 10 万，超过四视图容量）。这些改动在板上工作树，**未提交**。

## 1. 放置模型包（系统盘，约 3.3 GB）
系统盘现剩 7.9 GB，放完约剩 4.6 GB。SigLIP2 文件**保留**（回退要用）。

```bash
cd /home/sunrise/ainvr/ai-service/models/search
SRC=/mnt/ainvr-ssd/search-models-alternates/qwen3vl-embedding-2b-o2
cp -n $SRC/hbm/qwen3vl-emb-* hbm/
cp -n $SRC/data/qwen3vl-* data/
cp -n $SRC/tokenizers/qwen3vl-* tokenizers/
grep qwen SHA256SUMS.txt | sha256sum -c -
```
23 行应全部 OK。`SHA256SUMS.txt` 里已有这 23 行，无需改。文件属主应为 sunrise。

## 2. 检查（只读）
```bash
cd /home/sunrise/ainvr
AINVR_FRESH_AI_BINARY=out/build/qwen-ai/ainvr_s100p_control_service \
AINVR_FRESH_SEARCH_BINARY=out/build/qwen-search/ainvr_search_service \
node deploy-package/search_fresh_model_cutover.mjs --check \
  --from siglip2-base-full-int8 --to qwen3vl-embedding-2b-o2
```
应输出 `targetDimensions":2048`、`newPackage":"qwen3vl-embedding-2b-o2"`。

## 3. 执行（清库+切换，必须脱离终端）
```bash
cd /home/sunrise/ainvr
AINVR_FRESH_AI_BINARY=out/build/qwen-ai/ainvr_s100p_control_service \
AINVR_FRESH_SEARCH_BINARY=out/build/qwen-search/ainvr_search_service \
AINVR_FRESH_READY_TIMEOUT_MS=600000 \
setsid nohup node deploy-package/search_fresh_model_cutover.mjs --apply \
  --from siglip2-base-full-int8 --to qwen3vl-embedding-2b-o2 > /tmp/cutover.log 2>&1 &
tail -f /tmp/cutover.log
```
它会：备份两个二进制到 `/mnt/ainvr-ssd/ainvr-rollback/{ai-service,search-service}/<时间戳>/`；停三项服务；清 Mongo 的 `search_*` 七个集合（样本、覆盖、删除记录、会话、校验缓存、迁移报告、控制）、SSD 索引分片、PG 的 `search_jobs`/`search_index_shards`/`search_runtime_state`；写新设置；装二进制；启动并等待就绪。**不动**识别归档、录像、告警、通道和热区配置。成功末行是 `"phase":"ready"`。失败时它会让搜索保持关闭，不自动回滚，看 `/tmp/cutover.log` 和报告 `…/search-service/<时间戳>/fresh-model.json`。

## 4. 阈值（前端要改，后端不限范围）
后端接受 −1 到 1，只有前端写死了 0–0.1。Qwen 余弦尺度完全不同：板上实测贴切查询约 0.33–0.47，无关查询 0.25–0.27，随机图文约 0.17（27 条模拟样本，现场数据积累后需重标定）。建议默认 **0.30**，范围 **0–0.6**，步长 0.01。

改 `srs-web-console/frontend/src/pages/Search/index.tsx`：
- 第 31 行 `useState('0.035')` → `'0.30'`
- 第 32 行 `<= 0.1` → `<= 0.6`
- 第 295、297 行 `max="0.1" step="0.005"` → `max="0.6" step="0.01"`
- 第 302 行提示里的“0.035 为试用起点”→“0.30”

同步 `src/test/SearchPage.test.tsx`（第 173、744–752、758、777、781、840 行的 0.035/0.1/0.005）。然后：
```bash
cd /home/sunrise/ainvr/srs-web-console/frontend && npm run build
```
nginx 直接读 `dist`，不用重启。若以后要同一个页面兼顾两种模型，需要让页面按当前模型取默认值和范围，这是后续改造。

## 5. 上线后验证
1. `curl -s http://127.0.0.1:8000/health` 里 `business.search_sampling.ready` 为 true，`model_version` 以 `search-v1-` 开头。
2. 控制台搜索页：等 1–2 分钟后有样本；搜“人”，分数应在 0.3–0.5 区间，无关词应低于 0.3。
3. 新样本向量应为 2048 维（每条 8192 字节），证据里 `model_input` 为 896×448，且**没有** `scene_views`。
4. 观察 `journalctl -u ainvr-ai -n 100` 无反复重载；ION 约 3.75 GB 在无人使用约 90 秒后释放。
5. 告警复核用的 LLM 服务（4B）与 Qwen 嵌入同时占用 ION 的共存情况未在 12 GiB 扩容后重测，若 LLM 复核出现 OOM，请看这一项。

## 6. 回退
把 `--from` 与 `--to` 对调再跑一次（同样清空重积累）：`--from qwen3vl-embedding-2b-o2 --to siglip2-base-full-int8`。回到 SigLIP2 的设置是旧节奏下限再取 `max_samples ≤ 40000`；要恢复 20 秒固定节奏、`object=false`、8 GiB，请核对设置页。二进制备份在第 3 节的目录。

## 7. 清理历史垃圾
- 切换脚本已清：搜索样本、覆盖缺口、删除记录、索引分片及 PG 搜索状态（同时清掉了线上测试期间的 1139 条旧样本）。
- 可手工删（需要你确认）：`/mnt/ainvr-ssd/search-ab`（7.7 GB，A/B 评测素材）；`/mnt/ainvr-ssd/ainvr-rollback` 共 345 MB，保留最近几份即可。
- 不要删：系统盘上的 SigLIP2 模型文件、SSD 备份目录里的 Qwen 包（回退/重装用）。
