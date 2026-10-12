# AINVR 项目目录

目标平台：地瓜 RDK S100P。默认工作目录：`/home/sunrise/ainvr/`。

本轮按只读参考项目 TecheAI 的 Git 已跟踪目录建立骨架。目录相同不代表功能已经实现；源码、模型、密钥、依赖清单和部署脚本没有从参考项目复制。

| 目录 | 职责 |
|---|---|
| `ai-service/` | AI 服务：视频解码、预处理、模型接口、识别结果、截图与历史 |
| `ingest-service/` | 网络视频接入与拉流管理 |
| `recording-service/` | 分段录像、存储管理、索引与回放接口 |
| `srs-web-console/backend/` | 配置中心、业务接口与服务协调 |
| `srs-web-console/frontend/` | 网页监控、通道管理、回放、全景显示与识别历史 |
| `srs-web-console/deploy/` | 网页与流媒体模块的部署配置预留 |
| `license-service/` | 授权服务模块预留 |
| `relay-server/` | 远程协助中继模块预留 |
| `shared/` | 公共接口、客户端与宿主机辅助服务 |
| `deploy-package/` | AINVR 安装与发布打包模块预留 |
| `docs/` | 架构、部署、开发与实验说明 |
| `tools/` | 项目开发与维护工具 |

现有目录继续保留：

- `deploy/infra/`：已部署的 AINVR Docker 基础设施（SRS、PostgreSQL、MongoDB）。
- `test/`：S100P 硬件实验、脚本、运行文件和验证结果。
- `TecheAI/`：只读参考子模块；不得修改内容或子模块引用。

结构记录见 `docs/project-structure.json`，包含参考提交、模块列表和完整目录列表。
Git 不跟踪空目录，因此叶子目录使用 `.gitkeep` 保留，后续加入实际文件时可以删除占位文件。

AINVR 项目自身代码、品牌与版权署名使用 AINVR。第三方参考项目保持独立。
