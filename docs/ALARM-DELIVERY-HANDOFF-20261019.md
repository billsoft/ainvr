# AINVR 告警交付与提交检查

2026-10-19。开发目录 `/home/sunrise/ainvr`；板子 `192.168.100.189`。本文取代同日设计文档中较早的部署状态描述。Git 尚未自动提交或推送。

## 本期范围与职责

- AI 微服务负责检测、跟踪、轨迹，以及统一观测和精确原帧证据接口。
- 独立告警微服务负责规则执行、行为事实、一次活动的一条合并告警、独立证据保存、确认和审计。
- 参数库保存区域、监控器与版本历史；历史库保存行为事实、告警、消费检查点和图片状态。无需额外空间数据库。
- 四类业务对应五个行为编码：appearance、region_approach、region_contact、region_enter、region_traverse。接触表示框与区域相交，不表示物理碰撞。
- VLM 复核与通知只预留接口，当前不可启用。不新增短信、推送或大模型运行；越线客流产品也不在本期范围。

## 已修复的评审问题

1. `Monitor` 传入接入代次及创建时间，来源身份与原始尺寸共同匹配区域；通道改名不再改变几何版本。尺寸未知与来源标识未知分别提示。
2. 原始画面和已绑定的 AI 输出均可叠加区域；支持全部或单个区域。全景展开时不把原图区域错误绘制到变换后的画面。
3. 区域支持新增、编辑、触控拖动、方向键微调、撤销重做、归档。归档保留历史并提示不会自动停用引用旧版本的规则。
4. 规则向导显示区域轮廓；规则列表明确提示区域更新或归档后仍使用冻结版本，需要重新编辑确认。
5. 接近与接触保留去重状态，只有真实观测到离开容差范围并持续达到 rearm_ms 才重新触发。预测、低置信观测、传输缺口不能证明离开持续时间。
6. 活动按监控器和跟踪身份合并，阶段事实独立。停用最后一条规则也会收尾活动；旧的已准备结果重放不能重新打开已失效规则的活动。
7. SEI 序列化边界排除 label_catalog、observation_delivery 和内部 analytics，保留正常检测及显示推算字段，不污染视频载荷预算。
8. 局域网 HTTP 下确认使用 getRandomValues 操作编号，重试保持原编号及内容。单条、批量确认都保留审计和逐项结果。
9. 告警列表补充通道、区域、行为和首次发生时间筛选。行为筛选匹配活动任一阶段；游标绑定全部筛选条件。
10. 统计支持本地时区与夏令时分桶，支持区域、标签、执行规则筛选及进入/离开/运动方向分组。默认时间戳仍使用 UTC 存储。
11. 同一目标多条规则的事实不会伪装成实际人数：界面称“规则触发次数”，独立提供跨规则去重的跟踪目标数；可以按规则筛选。
12. 观测日志采用保守容量缓存；满容量拒绝不再逐帧预占编号、重复 fsync 或全目录扫描。保留同步持久化保证，不使用易丢失的内存队列冒充持久化。

## 部署与恢复

- AI：`deploy/s100p/bin/ainvr_ai_service`，SHA256 `6e39f3029bf703db0282fff9308eb4b6d7d2c2243753022f528c5b27c58fbe65`。19 组安全原生测试和 9 项跟踪回归已通过；许可证编译用户必须是 sunrise。
- 告警：`ainvr-alarm.service`，监听本机 8200，当前不可变版本 `deploy/s100p/alarm-service/release-20261019-230608`。
- 控制台候选：`/mnt/ainvr-ssd/ainvr-alarm-commit-final-20261019-225755`；后端及前端已替换。页面需刷新到新资源。
- 中央配置 desired/applied v6；告警数据库独立，密钥只保存在现有私有启动文件及加密参数库中。不要复制密钥到交接文档或命令行。
- 观测目录 `/mnt/ainvr-ssd/ainvr-observations`；证据目录 `/mnt/ainvr-ssd/ainvr-alarm-evidence`；证据独立保留当前 30 天、2 GiB。
- 生产迁移前备份：`/mnt/ainvr-ssd/ainvr-alarm-migration-backup-20261019-212050/configuration-before-alarm.dump`，已隔离恢复并验证；SHA256 `badf3a49b19fe9c387dbb0d8df32e7c37f022a14d03283c9611f18375d67cda3`。
- 每次更新均保存原 unit、dist.alarm-before-* 和结构化部署报告。最新 `test/results/alarm-submit-deployment-20261019.json` 记录精确恢复路径。仅回退需要的告警/控制台版本，不能用旧配置覆盖用户接入和 AI 绑定。
- 本次更新没有重启 AI 或录像；录像 PID 2418、单调启动时间 10940424 保持不变。

## 可复用脚本与证据

| 位置（仓库内） | 用途 |
|---|---|
| test/ai_port/build_alarm_native_candidate.py | SSD 冻结原生源码、保留许可证参数、构建与测试 |
| test/ai_port/build_alarm_web_candidate.py | SSD 冻结前后端并构建，检查源文件代次 |
| test/ai_port/deploy_alarm_ai_candidate.py | AI 候选事务安装及真实推理、SEI、录像保护验证 |
| deploy-package/install-alarm-console-s100p.py | 首次独立服务与控制台安装，已有部署不能重复当首次安装 |
| deploy-package/update-alarm-console-s100p.py | 已部署版本的事务更新与自动回滚；不重启视频服务 |
| deploy-package/provision-alarm-config-s100p.mjs | 首次建立本服务独立中央配置和私有身份；不修改已有密码 |
| test/ai_port/verify_alarm_migration_backup.py | 生产参数只读备份，隔离恢复和迁移验证 |
| test/ai_port/run_alarm_acceptance.py | 每次重新生成原生样本，运行完整告警套件并拒绝跳过项 |
| test/ai_port/verify_alarm_live_delivery.py | 只读采样真实推理／SEI、存储及配置不变性 |
| test/ai_port/check_alarm_erp_release.py | 当前提交前审计：显式提供候选目录与测试日志，核对源码及已部署产物哈希；旧 check_alarm_commit_ready.py 仅转发至此入口 |
| test/ai_port/observation_journal_test.cpp | 原生持久化、容量边界及恢复探针 |
| test/ai_port/observation_quality_probe.cpp | 原生跟踪、低置信、预测的消费边界样本 |
| test/ai_port/observation_journal_benchmark.cpp | 空队列、积压和满容量的 SSD 写入基准 |
| test/ai_port/alarm_browser_acceptance.cjs | PC 隔离浏览器测试控制器；密码仅通过 stdin 输入 |

可复现结果：`test/results/alarm-submit-final-service-20261019.log`（87/87）、`alarm-commit-frontend-final-20261019.log`（976）、`alarm-commit-backend-serial-20261019.log`（335，原有可选集成测试默认跳过）、`alarm-final-review-pg-20261019.log`（区域和监控器真实 PG）、`alarm-submit-zone-regression-20261019.log`（最终区域 UI 22）、`alarm-journal-benchmark-v2-20261019.log`。结果目录为本机实验记录，不应批量提交二进制或临时运行器。

宿主监视补充：`shared/host-restart-helper/observability.py` 已将告警服务加入进程资源、历史和日志来源；前后端均使用明确的服务白名单。就绪探测只按该进程持有的本机监听 socket 定位端口，适应端口变更，不读取凭据，也不探测其他进程。`/livez`、`/readyz` 仅提供存活／布尔就绪信息；业务接口继续鉴权。49 项监视助手测试通过，仪表盘实际显示 8/8 服务正常，并可进入告警服务日志。

完整告警验收可重跑：先启动只监听本机 27028 的独立测试 Mongo，然后执行：

```sh
python3 test/ai_port/run_alarm_acceptance.py --tracking-library /mnt/ainvr-ssd/ainvr-alarm-native-sei-20261019-205855/tracking-build/libbytetrack_service.a
```

tracking-library 参数必须指向已验证构建的 ByteTrack 静态库；报告保留其 SHA256。原生 journal 是消费后删除的队列文件，不能用已经消费的旧目录重跑测试。本次最终可复现实测报告 `test/results/alarm-acceptance.json` 为 87/87，无失败和跳过，并固定了源码哈希。

后端全量并发运行时曾出现无关用例的 10 秒超时，失败日志保留在 `alarm-commit-backend-20261019.log` 和 `alarm-commit-backend-final-20261019.log`。停止其他构建／测试并以单 worker 重跑后 335 项全部通过；未放宽断言或超时。其 32 项原有可选集成用例默认跳过，其中本期区域与监控器 2 项已在独立 PG 上额外启用并通过。其余可选集成不冒充已验证。

## 提交流程与保留限制

- 本次移除了已跟踪的 backend/tsconfig.tsbuildinfo；文件留在工作目录并忽略。原生探针可执行文件、依赖目录、部署包、私有配置与 dist 备份均不提交。
- 提交需要包括新增 alarm-service 源码/锁文件/测试、BFF 迁移与路由、前端页面、原生观测与证据代码、可复用脚本及文档；不能只提交 git diff 中已跟踪的部分而遗漏未跟踪源文件。
- 现有跟踪提交 e8f5555、4c63e8b 保留，不重置、覆盖或改动子模块。
- 统计输入覆盖率仍明确 unknown；空白时段不能当作零事件。跟踪目标数不是跨断流、遮挡或身份切换后的真实去重人数。
- 多条重叠规则可以各自产生事实，不能直接宣称区域客流总数。当前统计不提供跨规则的物理访问次数归并。
- 接近范围是归一化图像距离，方向是画面钟面方向；不代表米、地理方位或物理碰撞。
- 图片为对应原帧的目标裁剪，受独立容量与期限约束，不是永久保存或整幅画面录像。
- 无法处理的协议记录保留队首、显示阻塞原因，不静默丢弃；应核对模型标签/来源绑定并修正规则。不得通过删除日志掩盖故障。
- 历史密钥需按配置版本引用清理；仍被回滚版本引用的记录不能当作垃圾删除。

## 最终真实页面验收

验收进度与截图见 `test/results/alarm-submit-browser-20261019.json`。覆盖真实大门原始视频和 AI 输出、区域绘制与叠加、规则保存、确认、统计、系统配置与仪表盘。测试规则和区域使用“验收临时”前缀，完成后归档，保留审计。

内置浏览器控制工具在本机会话报告内核资源路径错误；实际交互验收使用独立 Edge/Playwright 上下文，未读取或修改用户浏览器配置。不能把这项替代验收表述为内置浏览器工具已恢复。

## 最终提交检查结论

`test/results/alarm-commit-readiness-20261019.json` 已输出 ready_to_commit：检查了已跟踪差异和新增源码（169 个文件）、暂存区、冲突标记、生成物、Python 语法、完整测试证据、源码与已部署产物的一致性。未自动提交或推送。

真实页面记录 19 项检查及 10 张截图，包含 1024×768 触控布局、真实原始视频与 AI 检测框同屏区域、绘区编辑归档、冻结版本提醒、单条和批量确认、统计与配置以及资源／日志监视。最新稳定采样推理和 SEI 一一对应，暂存失败 0；AI 与录像进程身份保持不变，仪表盘 8/8 服务正常。

验收数据状态：两个测试规则和一个测试区域已归档；1135 条测试告警、行为事实和独立截图保留，其中页面验收已确认 3 条。额外批量确认其余验收历史的操作被自动审批审查拒绝，工具仅返回 blocked by policy、未说明具体原因，实际没有执行。后续启用通知时不得把这些历史验收数据当作新告警回填发送。

独立测试 Mongo 和 PG 容器已停止，保留用于后续复测；未停止生产数据库、SRS、AI 或录像。重新跑数据库集成前需先启动对应测试容器，并继续使用固定的隔离端口。
