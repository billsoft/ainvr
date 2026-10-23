# 目标特写、队列积压与资源容量验收

本组测试不会安装自动审核资格、写入生产告警或修改通道参数。结果目录位于
`test/results/`，属于设备本地运行记录；测试源码可以提交，图片和结果不提交。

## 测试入口

- `review_v2_acceptance.py --seconds 3600 --manifest <JSONL>`：使用配置中心现有
  `alarm-review` 调用方，通过生产图片准备和 BPU 推理接口验证指定目标；先采样
  60 秒无请求基线，再提交一小时串行请求。检查原通道配置、生产服务 PID、RSS、
  文件句柄及重复输入分数。凭据只在进程内读取，不输出到报告或命令行。
- `review_backlog.mjs`：仅连接 `127.0.0.1:27028` 的隔离 Mongo 随机测试库，
  先逆序存入 200 条告警，再按发生时间审核，中途重建 Worker 并模拟人工审核。
  模型调用为模拟，不能用此结果宣称真实 BPU 吞吐或准确率。
- `review_dual_capacity.cpp`：隔离的第二个解码／检测订阅者，读取同一来源并加载
  同一检测模型，最多运行 900 秒，目标 10 FPS。没有第二路归档、录像或 SEI 输出，
  因而不等于两个独立生产相机通道的完整验收。必须使用与当前生产一致的头文件
  和静态库构建；旧 `ai-api-compat` 构建目录可能有 ABI 差异，不能混用。
- `summarize_review_v2.py`：按冻结的 0.05／0.95 阈值统计开发集与独立测试集，
  始终输出 `automatic_review_qualified=false`，不会签发资格或调整生产阈值。

重复运行前应保存上一轮 `review-v2-acceptance/` 输出。运行硬件测试时保持串行；
第二检测器只用于明确标注的共存测试。不要读取 ION debugfs。

## 数据边界

本次清单为 32 个开发图像组、64 个独立测试图像组，每组对同一标注目标分别
测试正确类别与错误类别，共 192 项。原图来自已有 COCO 拼接图，目标框来自其
YOLO 格式标注；仅在已有开发／测试划分上选择，不在测试集调阈值。

标签表达的是**指定框的目标类别**，不是整张图是否存在某个类别；错误类别可能
在周围背景或重叠物体中真实存在。该测试用于发现目标指向性问题，不能直接推导
现场误报率。每组正负样本相关，不能当作 192 个独立场景。缺少火灾、海报、镜像、
假人等现场人工标注，不足以批准任意标签的通用自动审核资格。

## 本轮设备记录

- `test/results/review-v2-targets.jsonl`：冻结的目标框与标注来源哈希。
- `test/results/review-v2-acceptance/report.json`：逐请求分数、模型哈希、耗时及资源采样。
- `test/results/review-v2-acceptance/images/`：模型输入 JPEG 展示副本和上下文图。
- `test/results/review-v2-acceptance/summary.json`：冻结阈值结果和未验证边界。
- `test/results/review-backlog.json`：200 条积压／人工跳过／Worker 续跑结果。
- `test/results/review-dual-capacity-current.json`：当前库构建的第二检测器结果。

最初探针使用旧库失败；改用当前库后，补齐只用于测试的通道编号、删除 API 派生
字段并统一绝对模型路径。初始失败保留日志，不能混作生产故障或容量通过证据。
