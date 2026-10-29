# 智能搜索基础链路发布记录（2026-10-29）

## 已发布的范围

开发测试板 `192.168.100.189` 已安装 `out/search-release-20261029-r1`，使用统一 search 发布 profile；代码未提交或推送。默认包 `siglip2-base-full-int8`，模型文件不随程序复制或更换。程序、运行环境及参数库沿用系统盘；搜索证据在现有 MongoDB，索引在选定 SSD 的 `ainvr/search-index`，不回退 eMMC。

当前通过同一配置仓库、搜索配置准备器及发布编排器启用，审计 actor 为 `user-authorized-ssh`，配置版本 v13。保留原配置后选择唯一已挂载可用 SSD 和支持采样的「后门8K全景AI输出」。大门输出声明 `erp_equirect`，未绕过投影保护，也未修改其摄像头、AI 模型、录像、布防或计数。后台报告期望版本与应用版本均为 13；Native `ready=true`，AI 搜索采样 `ready=true`、`control_failures=0`、`needs_reconcile=0`，BPU 健康、隔离字节为 0。

入口：`http://192.168.100.189:8088/smart-search`。登录后可搜索新采集的证据；不会自动把上线前全部录像转换成检索历史。界面返回的是候选及相似度，不是确认事实或概率。

## 验证与实际边界

- 最新受控硬件整链 251 项检查通过：真实 PG、MongoDB、SSD 发布、实际受管 Native 与 BPU 客户端、版本 ACK、停用及过期请求保护。日志：`test/results/search-managed-hardware-final.log`；隔离数据与进程已清理，原服务身份未改变。强制 ROI 和官方样本只证明接口链路，不证明现场语义准确率。
- 基础发布后，真实输入持续产生样本；Native 中文查询「穿蓝色工作服的人」返回 HTTP 200、5 条候选、`partial=true`。`test/results/search-production-smoke.log` 中的高水位是写入序号，不是当前图片总数。
- 写入隔离分别通过 133 项实际 MongoDB 故障检查、71 项实际数据库／admission 编排检查和 Native 27 组 CTest；AI producer 276 项检查验证提交前拒绝不会变成永久 Unknown。编排检查中的 PG 报告回调是显式软件 oracle，不能当真实 PG 整链证明。
- 配置切换相关真实 PG 57 项、后端 105 项、前端 49 项及额外准入 19 项通过。桌面与窄屏的隔离浏览器验证覆盖真实组件，报告为 `test/results/ui-acceptance-20261029/report.md`；它使用模拟 API。发布后浏览器控制能力不可用，未冒报已完成登录后的生产 UI 全链验收。

本次不声称完成中文监控召回率、夜间／遮挡效果或长期容量验证。用户已明确不以 24 小时测试作为本期完成前提；仍需完成必要功能与实际效果验收。

## 暂未开放的模型切换

`AINVR_SEARCH_MODEL_MIGRATIONS_ENABLED` 默认关闭；只有显式设为 `1` 且 Native、AI 能力同时具备才允许新迁移。已发布的旧任务仍允许恢复。基础采样、查询与复核不受该开关控制。M4 尚未完成，不能标为发布通过。

独立 5 万 source＋5 万 target 测量：全量覆盖及已有文件验证需 141.19 秒，已超过 final 暂停目标 120 秒。这是合成向量、4 字节测试 JPEG、真实 MongoDB／SSD、PG HTTP oracle、预构建分片且无 BPU 的测量，不是百万迁移或实际视频容量通过。所需后续工作为 settled H0 证书、已接受 base 证明继承、仅增量验证及现有分片 manifest 的增量发布；不能只修改扫描起点冒充解决。资源及测试目录已清理。

## 发布与回滚

发布前只读预检通过；发布过程中原参数保留，SRS、录像、接入、告警、ONVIF 与国标服务未重启。AI、LLM、后台及新搜索服务完成程序安装，原 AI 输出在重启期间有短暂中断。

SSD 回滚事务：`/mnt/ainvr-ssd/ainvr-rollback/backend/20261029T040736Z-1793246856041115901`。同一事务引用各服务的校验过备份，每服务最多三份。统一入口：

```bash
python3 deploy-package/deploy_ptz_release.py --profile search --rollback /mnt/ainvr-ssd/ainvr-rollback/backend/20261029T040736Z-1793246856041115901
```

该命令会改变运行程序，不能当只读检查执行。回滚保留增量数据库 schema，不删除历史或重置其他通道配置；若上线后另行改动 LLM／搜索配置，应先核对旧程序兼容性与实际配置，不能把程序回滚等同配置回滚。证据、模型、凭据和构建产物不提交 Git。
