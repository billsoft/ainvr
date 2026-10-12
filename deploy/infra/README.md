# AINVR 基础设施（RDK S100P）

本目录独立部署基础设施，参考项目及 Git 子模块保持只读。

| 服务 | 对齐的镜像标签 | 板端入口 |
|---|---|---|
| SRS | `ossrs/srs:7.0.162` | RTMP TCP 1935；WebRTC UDP 8000；SRT UDP 10080 |
| PostgreSQL | `postgres:16-alpine` | `127.0.0.1:5432` |
| MongoDB | `mongo:7.0` | `127.0.0.1:27017` |

SRS 管理接口为 `127.0.0.1:1985`，HTTP-FLV 为 `127.0.0.1:8080`。
WebRTC 候选地址默认 `192.168.100.189`，可在本目录 `.env` 中设置
`SRS_CANDIDATE`。本轮没有部署网页网关、AI、录像或 HLS 服务。

## 启动和验证

以下操作在开发板执行：

```sh
cd /home/sunrise/ainvr/deploy/infra
sudo ./install-docker.sh
sudo ./up.sh
sudo python3 verify.py --output /home/sunrise/ainvr/test/results/infra-check.json
sudo docker compose ps
sudo docker compose logs --tail 50
```

首次部署验证可加 `--restart`，检查重启 PostgreSQL/MongoDB 后测试数据仍在。
它会重启这两个数据库容器，日常检查默认不重启。测试使用临时测试记录和
有限时长的 640×320 H.264 合成视频，不代表 8K 性能或 WebRTC 浏览器验收。

Docker 使用 Ubuntu 维护的 ARM64 包。S100P 按地瓜官方 FAQ Q30 使用
`iptables-legacy`/`ip6tables-legacy`，无需更换内核或重启开发板。

当前 4.0.5 内核还没有 `CONFIG_IP_NF_RAW` / `CONFIG_IP6_NF_RAW`，新版 Docker
桥接容器启动时会失败。因此本部署使用 `network_mode: host`，端口由服务直接监听，
PostgreSQL/MongoDB 与 SRS 管理/HTTP 接口在服务配置中明确绑定 `127.0.0.1`。
未启用 Docker 的不安全 raw 表绕过选项。以后其他容器若使用默认桥接网络，仍需单独
解决该内核兼容问题。宿主机网络没有容器专用网卡/IP，服务间连接使用本机端口。

## 镜像与离线导入

`fetch-images.py` 可在能访问 Docker Hub 的 Python 3.11+ 主机运行。
它只下载官方仓库的 Linux ARM64 镜像，并逐项验证配置和图层 SHA256。
把生成的压缩镜像及 `images.lock.json` 传到板端后执行：

```sh
sudo python3 /home/sunrise/ainvr/deploy/infra/load-images.py /path/to/offline-images
sudo /home/sunrise/ainvr/deploy/infra/up.sh
```

`images.lock.json` 记录来源、标签、平台、上游摘要、镜像 ID 和压缩包校验值。
启动前检查镜像 ID，可避免浮动标签被更新后无意换版本。此锁定不等于自动更新；
以后更新需要重新下载、验证并更新锁文件。

Docker 29 的 containerd 镜像存储会把清单摘要显示为镜像 ID；离线封装后的清单摘要
也可能不同。因此检查脚本会读取本地清单，核对它引用的配置摘要与上游配置摘要一致，
并检查 Linux ARM64 平台。下载阶段另外验证压缩图层和解压图层的 SHA256。

## 数据与凭据

- PostgreSQL 数据：`/home/sunrise/ainvr/deploy/infra/data/postgres/`。
- MongoDB 数据：`/home/sunrise/ainvr/deploy/infra/data/mongo/`。
- 凭据：本目录 `secrets/`，父目录权限为 root 专用的 0700，不入 Git。
- PostgreSQL 应用库与账户：`ainvr_config`，凭据文件 `pg_app_password`。
- MongoDB 应用库：`ainvr_snapshots`，账户 `ainvr_ai`，凭据文件 `mongo_app_password`。
- 两个数据库各自有独立的 `ainvr_admin` 管理账户和管理凭据。

`prepare.py` 只在凭据缺失时生成随机密码，重复运行不会更换密码。
数据库和凭据必须一起备份。不要单独删改已有凭据文件；初始化脚本只对空数据目录执行。
容器自动重启策略为 `unless-stopped`，Docker 开机启动。停止服务可使用
`docker compose stop`，数据目录仍保留。

官方参考：
[Docker Ubuntu 安装说明](https://docs.docker.com/engine/install/ubuntu/)、
[地瓜系统 FAQ](https://developer.d-robotics.cc/rdk_s_doc/FAQ/hardware_and_system)、
[SRS Docker 文档](https://ossrs.io/lts/en-us/docs/v7/doc/getting-started)。
