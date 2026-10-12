# AINVR S100P HLS 进程隔离

部署入口为 `deploy/infra/compose.yaml`，镜像固定 `ossrs/srs:7.0.162`。
S100P 使用 host 网络；主进程接收 1935 流，独立 HLS 进程仅监听
127.0.0.1:1936。HTTP 仍由主进程在 127.0.0.1:8080 提供。

HLS 文件写入容器内 `/run/srs-http` 的 2 GiB tmpfs（容量上限，非预分配），
SRS 容器内存上限为 3 GiB，为进程及缓存保留余量。实际多路流仍需内存压力验收。
主进程 HLS 关闭，通过 10 秒有界转发队列向 HLS 进程送流。

沿用 AINVR 的 `srs-web-console/deploy/srs-entrypoint.sh`：

- 检查 tmpfs 挂载及两份配置，缺少挂载时拒绝启动。
- HLS 退出后独立恢复，不重启主接流进程。
- 80% 容量产生压力日志；95% 或发生写入失败后，在容量降至 80% 以下时仅重启 HLS。
- Docker 日志使用非阻塞 4 MiB 缓冲和 10 MiB × 3 轮转。

## 板端回归

从 `/home/sunrise/ainvr` 执行：

```sh
SRS_IO_INTEGRATION=1 python3 test/non_ai/test_s100p_hls_isolation.py
SRS_IO_INTEGRATION=1 SRS_TEST_CODEC=hevc python3 test/non_ai/test_s100p_hls_isolation.py
```

测试只创建唯一命名的临时容器，使用独立的 21935、21936、21985、21880 TCP
端口和 28000、28080 UDP 端口；启动前检查端口占用。串行执行，不与其他相同测试并行。
使用 32 MiB 临时内存盘、1 秒分片加速故障验证；不是生产容量或高码率压力测试。
分别注入 HLS 暂停 14 秒、进程退出、磁盘写满并恢复，检查发布连接 ID 不变、
接收数据继续增长及播放列表恢复更新。测试结束移除本次临时容器。

上线前两份配置自检由 `deploy/infra/up.sh` 执行。已有 SRS 容器需要重建才能应用
入口和内存挂载变更；这会短暂中断接流。数据库数据卷不变。
