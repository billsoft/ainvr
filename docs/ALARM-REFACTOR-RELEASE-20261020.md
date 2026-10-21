## 最新复评（2026-10-20 22:37）

本节替代下方旧轮次状态。详情统一维护于 [逐项评审处理](ALARM-REVIEW-RESOLUTION-20261020.md) 首节，避免多份文档重复维护。

- 已部署 review2 Web / review2-r2 告警候选，发布目录 release-20261020-223625；没有自动提交。
- 最终前端 1057、后端 425、告警 116 项全部通过，无跳过。最新提交检查为 alarm-erp-commit-readiness-20261020.json。
- 布防必须显式声明普通平面或全景画面；后端要求全景声明才能保存环绕区域。新区域模式不再由视图按钮顺序决定；旧平面区域不改义。截图全景处理设置不等同相机类型。
- 全景区域小于半圈；接近距离比较相邻副本的真实边界距离。三处几何实现使用共享测试向量。
- 关闭识别框同时隐藏推算、低置信框，轨迹仍常显。
- **未实现跨接缝跟踪身份连续性**：保存、显示、同 ID 几何判定可用，不代表真实跨接缝计数完整；界面已有明确限制。需可靠计数时远离接缝布防。本轮没有修改或重启 AI 跟踪服务。
- 实体 iPad 未实测；触摸事件测试与实际浏览器保存重开已验证。

---

# 告警触发重构：最终发布与历史证据

## 最终发布状态（2026-10-20 22:23）

用户已明确授权完成重构、测试并部署。本节替代下文历史轮次的“待批准”“未部署”和旧测试计数；历史记录保留用于追溯，不作为当前操作指令。未自动提交或推送。

- Web 最终候选：`/mnt/ainvr-ssd/ainvr-alarm-refactor-web-20261020-erp-r3`。
- 告警服务候选：`/mnt/ainvr-ssd/ainvr-alarm-refactor-service-20261020-erp-r2`。
- 已部署服务：`deploy/s100p/alarm-service/release-20261020-221229`。完整部署后追加前端提示修正，后端和告警服务未重复重启。
- 最终测试：前端 135 文件 / 1051 项，后端 68 文件 / 420 项，告警 110 项，全部通过，无跳过。
- `test/results/alarm-erp-commit-readiness-20261020.json` 核对源码、候选和已部署文件哈希、Git 差异、误提交产物、浏览器保存契约和现网健康，结论 `ready_to_commit`。
- 生产 10 秒复测：100 次推理 / 100 次 SEI，约 9.99 FPS，阶段失败 0、观测失败 0、积压 0。AI PID 2652618、录像 PID 2418 与发布前相同，通道配置不变。
- 发布前没有启用的执行规则，发布后仍为 0。旧验收触发器已归档，历史记录保留；不可等价转换的历史区域/方向明确要求重新确认，不静默启用。

### 最终算法与交互契约

触发器定义、来源热区、选用关系、执行规则分离；触发器不选通道。实时监看布防中，画面或热区选用一个或多个触发器，统一草稿、撤销/重做、取消不写库，保存同事务提交。删除热区先列出受影响选用；解除选用后对应执行规则停止。

360 编辑沿用视频相机与反射坐标约定，视口点逆投影回 ERP 归一化坐标；检测框、轨迹、热区共享投影约定。新全景热区显式保存 `erp_wrap`，原有平面区域含义不变。跨左右接缝的区域按最短横向路径展开，二维显示为左右两份裁剪，三维显示连续；后端以同一展开几何判定，边号保持稳定。对外证据点重新归一化到 [0,1]。

歧义半圈边、绕极点或覆盖一整圈的区域明确拒绝，需拆成较小区域；不声称支持任意球面多边形。距离仍是画面宽度比例，不是真实物理距离或球面测地距离。

### 验收证据与限制

- 自动测试包含相机正逆变换、不同视角/FOV/宽高比、背面裁剪、跨接缝几何、指针释放/取消、360 拖点回存 ERP、PG 幂等保存及执行快照。
- 实际浏览器隔离验收：新建/编辑触发器、全画面选用、热区选用、边方向、保存重开、删除区域同时解除选用；360 编辑、旋转、拖点和 ERP 接缝回显。
- `test/results/erp-browser-contract-verification.json` 将浏览器实际保存的规则送入真实判定引擎，跨接缝穿过只产生一次事件，进入边 3、离开边 1（零起始）。删除区域后只剩全画面出现选用。
- 生产真实视频进入 360 布防并绘制草稿已验证；验收草稿已取消，没有添加生产布防。
- 实体 iPad 未实测；已完成触摸 PointerEvent 自动测试和真实桌面浏览器验证，不能把两者当成 iPad 实机验收。
- VLM、声音、通知发送不在本期；保持预留接口和待确认角标。

### 复核与恢复

运行 `python3 test/ai_port/check_alarm_erp_release.py --web-candidate /mnt/ainvr-ssd/ainvr-alarm-refactor-web-20261020-erp-r3 --alarm-candidate /mnt/ainvr-ssd/ainvr-alarm-refactor-service-20261020-erp-r2` 重新检查；源码改变后旧报告不再代表新版本。

完整部署报告：`test/results/alarm-submit-deployment-20261019.json`；追加前端报告：`test/results/alarm-submit-dashboard-deployment-20261019.json`；现网报告：`test/results/alarm-submit-live-20261019.json`。文件名历史日期不代表实际执行时间，以报告时间字段为准。

备份/恢复目录：`/mnt/ainvr-ssd/ainvr-alarm-rollout-20261020-221229`。隔离备份恢复与迁移回滚演练见 `test/results/alarm-refactor-backup-20261020.json`。迁移 003–008 保留；不要删除历史迁移。

---

## 以下为发布前历史轮次记录

# 告警触发重构：候选、验证与部署关口（2026-10-20）

## 当前结论

候选已经构建并完成下述检查，但尚未获准部署，也未提交代码。本文件不能替代部署批准。
源码工作目录为 /home/sunrise/ainvr。用户手工配置的接入、AI通道、录像和模型必须保留。

## 固定候选与证据

- Web候选：/mnt/ainvr-ssd/ainvr-alarm-refactor-web-20261020-1935。status.json为passed，deployment_performed=false；source-manifest.json记录冻结源码，artifacts记录前后端构建摘要。
- 前端：129文件1029项全部通过，test/results/alarm-refactor-full-frontend-r4.log。
- 后端：65文件413项全部通过，无跳过，test/results/alarm-refactor-full-backend-r3.log。运行时同时启用隔离PG和Mongo开关，不能用默认跳过集成的测试代替。
- 告警：104项全部通过，无跳过，test/results/alarm-acceptance.json及.log；包含新生成原生观测样本，报告包含来源哈希。
- 编译规则→HTTP观测输入→真实Mongo→统计/确认：alarmCompiledHttp.test.ts，覆盖未选用、解除选用、仅统计、重复投递、确认不改变统计，以及不补造其他行为。
- 完整候选Monitor/VideoPlayer→真实3840x1920视频→绘区→隔离PG保存→热区回显→切换AI输出→全屏布防：test/results/alarm-monitor-browser-1935.json及截图。
- WebRTC真实SEI检测框与区域同屏；关闭普通检测框后轨迹和推算框仍显示：alarm-monitor-webrtc-1935.json、alarm-monitor-webrtc-all-1935.jpg、alarm-monitor-webrtc-trails-1935.jpg。
- 上述UI测试的通道目录/规则是隔离fixture，视频来自既有SRS。未修改现网通道或生产热区；不能把它描述为生产配置已经上线。

## 迁移备份与恢复预演

执行器：test/ai_port/verify_alarm_refactor_backup.py --candidate <上述候选路径>。

本次生产参数库只读备份：
/mnt/ainvr-ssd/ainvr-alarm-refactor-backup-20261020-194554/configuration-before-alarm.dump

SHA256：ac7f7d0b87677981c8c1b9859b9bb8afa2eae068927397d7cb714119af7fe680。
备份为私有文件（0600），不要提交、上传或在日志输出内容。

恢复到一次性隔离PostgreSQL后，实际执行候选003–008 SQL迁移及候选编译后的migrateLegacyAlarms：

- 原库已到005，本次需006、007、008及运行时旧选用转换。
- 4个旧触发器可转换，3个要求复核；不能将待复核配置自动启用。
- 第二次运行转换：converted=0、review=0，证明重复启动不会重复导入。
- 非告警表内容摘要、参数行数全部不变。
- 恢复库最终版本8；测试容器已清理。
- 报告：test/results/alarm-refactor-backup-20261020.json。

这是当时备份的预演。真正部署前必须重新备份并复验，因为用户仍可能修改配置。

## 部署前还必须完成

1. 核对候选来源哈希仍与所审源码一致，固定告警服务候选及其依赖摘要；不可临时把未审工作树文件打包上线。
2. 完成触摸输入验证。1024×768浏览器布局及鼠标/键盘操作已验证，不能称原生iPad已经验证。
3. 隔离整链路已通过：真实PG布防保存→AlarmRuleSync真实HTTP→告警服务→原生格式观测文件→ObservationPump→真实Mongo统计/告警；上线后仍须验证生产观测来源和应用状态。
4. 修订部署脚本的回滚语义：原update-alarm-console-s100p.py只回退程序目录/unit，不自动撤销数据库迁移。不能把其rolled-back状态说成业务配置也已恢复。
5. 固定旧程序、unit、中央配置/规则修订号和视频服务进程身份，列出3项待复核转换的影响，向用户请求最终部署确认。

## 部署与回滚约束

- 未经确认，不运行install/update脚本，不替换dist、不重启服务、不执行生产迁移。
- 先备份并预演，再部署相容的后端、告警服务和前端；确保新规则仅在新消费端就绪后应用。
- “保存成功”与“服务应用成功”必须分开；同步未确认不得显示已生效。
- 保留旧前端资源供已打开页面过渡，禁止旧页面通过旧写接口改变新布防。
- 失败先停止新规则应用并保持告警配置失败可见，再依据已核对的版本执行回滚；不能静默恢复已被用户修改的旧规则。
- 不把整库旧dump覆盖生产：那会丢失备份后的通道、服务参数、凭据和审计变化。数据库恢复必须限定告警对象并检查版本，保留审计；若不能保证则保持暂停并人工处理。
- 只回退程序时，旧规则已被迁移暂停，告警可能暂时不执行。必须明确展示这一状态，不能声称恢复后全功能正常。
- AI、录像、SRS原则上不重启；部署后对比进程身份、推理/SEI计数、观测暂存失败、录像与原8槽/试用通道配置。
- VLM、声音、短信、推送不启用，仅待确认数量角标。

## 尚未确定的业务参数

五项已确认：底边中点、宽度百分比距离、星期时段、触发次数与目标数、角标无声音推送。
其余推荐值（例如统一30秒活动结束、每路16区）不是整体批准。碰撞侵入不得宣称物理碰撞，当前区域进入判定不能冒充未经确认的框接触判定。

## 19:53 隔离规则同步与观测消费联合验收

- 新增 backend/src/test/alarmDeliveryChain.test.ts；使用独立PG schema、Mongo数据库、临时观测目录及127.0.0.1随机端口，结束后清理。
- 未配置规则时保留观测文件；发布布防后消费并生成一条告警。
- 服务关闭后，原先已应用的同步器返回pending；暂停定义并恢复服务后应用最新版本，不再生成该触发器告警。
- 恢复为仅统计后新增行为事实，但不新增告警；统计最终为2次、2个跟踪目标。
- 联合规则同步、编译HTTP和布防存储回归：4文件14项通过、无跳过；后端类型检查和git diff --check通过。
- 证据：test/results/alarm-delivery-chain.log、alarm-delivery-chain-regression.log。
- 这次使用合成的原生格式观测，不证明现网C++生产端全链路；生产服务未替换，独立测试数据库容器已停止。

## 冻结告警服务候选与部署脚本修订

- 候选：/mnt/ainvr-ssd/ainvr-alarm-refactor-service-20261020-2003。源码、测试和25MB依赖均为独立副本，不链接可变工作区。
- build_alarm_service_candidate.py 从候选直接运行全部104项测试，104通过、0失败、0跳过；包含新生成C++原生观测和质量样本。
- artifact-manifest.json摘要：e141f9cbbc45c897c01b7f455f9a989d7626971bf74b94f4cfdf6fe9d677879c。依赖清单摘要：c2733b2befd5f4a4895c5c54041414e29515f3d618f6e398eae810fa32e72f5e。
- 首次2000候选缺少共享星期时段测试样本，失败保留；补齐共享样本后生成2003候选，不能使用2000候选部署。
- update-alarm-console-s100p.py完整更新现在要求--alarm-candidate；检查候选通过、文件完整清单、源码一致性、无符号链接，复制后再次校验；不再临时打包工作区或共享旧release依赖。
- 回滚状态修正：后端已启动过时报告programs-restored-database-unverified，并明确database_restored=false、business_configuration_verified=false。此修改只纠正报告，不表示数据库回滚已实现。
- 尚须补齐有版本保护的数据库业务回滚/失败处置演练；禁止以现有脚本的程序恢复当作全功能恢复。部署脚本本轮只通过语法检查，未执行部署。
- Web1935候选的工作区清单因新增联合验收测试已变化，正式部署前需重新冻结并核对；不能跳过其代次校验。

## 20:00 告警配置回退隔离演练

- 新增test/ai_port/alarm_migration_rollback.mjs：配置事务锁、完整告警配置指纹校验；仅在迁移状态未变化时恢复可等价旧触发器，待复核保持暂停；停用新选用，保留schema及全部版本历史。
- 不恢复整库，不回退通道、录像或服务参数。恢复使用递增版本及rollback-008-assignments审计记录。
- alarmLegacyRollback.test.ts先失败后通过；与迁移测试合计4项通过，无跳过；类型检查通过。覆盖非告警用户修改保留、告警并发修改拒绝、重复回退拒绝和迁移不会再次导入。
- 最新私有备份目录：/mnt/ainvr-ssd/ainvr-alarm-refactor-backup-20261020-200015；备份SHA256：239a7b2db7f78030fbdbd3b3df77d5d2507d48bd37e3e0c10b839639787181bb。此前备份仍保留。
- 用该备份在隔离PG执行候选SQL003–008、运行时转换及配置回退：转换4项、待复核3项；回退恢复4项、暂停3项。原条件逐项相等，新选用无active，非告警表内容摘要未变。
- 报告test/results/alarm-refactor-backup-20261020.json已更新为本次演练；回归日志alarm-rollback-red.log、alarm-rollback-green.log。
- 尚未接入生产更新脚本：正式流程必须在迁移完成、开放写入口和发布新规则之前保存guard；不能在失败后重新取guard当作批准覆盖用户修改。回退时须停止配置发布者、验证旧服务重新加载旧快照后才报告恢复成功。
- 生产库本轮只读备份，未执行迁移/回退；隔离测试容器均已停止。

## 触摸指针隔离修复与前端回归

- ZoneEditor原先未记录pointerId，第二根手指可覆盖顶点/平移操作，lostpointercapture也未恢复草稿。现仅响应起始指针；其他指针的移动/松开不结束原操作；取消或丢失捕获恢复原形状。
- ZoneEditorTools新增touch类型、不同pointerId组件用例，先2项失败后通过；区域与布防相关17项通过。前端类型检查通过。
- 全量前端r5：129文件1031项通过，日志test/results/alarm-refactor-full-frontend-r5.log。该次shell退出标记因本地转义错误无效，不作为证据，以上计数来自Vitest最终摘要。
- 当前CUA文档仅提供鼠标点击/拖拽，无触摸注入接口。组件模拟touch指针不等于原生iPad Safari验收；真实触摸设备验证仍未完成。
- 新Web候选路径/mnt/ainvr-ssd/ainvr-alarm-refactor-web-20261020-2006，状态以其status.json为准。1935候选不包含本次触摸修复。未部署。

## 20:12 部署协调流程接入（本节更新此前未接入说明）

- update-alarm-console-s100p.py现先停止backend/alarm发布与消费，再创建私有生产备份、调用离线迁移执行器，并原子保存迁移后guard，之后才替换/启动新版本。AI/录像/SRS不在重启列表。
- 离线执行器alarm_offline_migration.mjs使用候选编译后的迁移代码；数据库连接从原运行进程环境仅在内存继承，不写入报告/脚本。恢复模块复制到私有部署目录。
- 失败时先停backend/alarm，恢复程序，然后用原guard恢复数据库；guard丢失、配置变化或恢复失败时保留两服务停止，报告manual-recovery-required，不假报成功。
- 数据库恢复返回递增后的配置revision；旧服务启动后必须报告同一revision已应用，才报告rolled-back。
- alarm_rollout_orchestration_test.py两个隔离编排测试通过：验证停止发布者→备份/迁移→失败→数据库恢复→启动旧服务的顺序；验证恢复失败不再启动发布者。系统服务调用均为模拟，未操作生产。
- 新版离线执行器已用实际生产备份在隔离PG完成prepare/rollback：4恢复、3暂停；测试报告backup_directory为/mnt/ainvr-ssd/ainvr-alarm-refactor-backup-20261020-200959，SHA256 b3836af3246df56819dd1d9fe20dea92b06e2dbb43f89cf0f9e5299c03487577。
- 恢复函数返回revision的补充改动经真实PG两项回归通过，日志alarm-rollback-final.log。
- 仍未获准部署，未执行生产迁移或服务切换。首次切换会短暂停止控制台和告警消费，推理录像继续；正式验收不能只看服务ready，必须核对实际rule revision、录像/推理/SEI和观测积压。


## 最终补验与替代候选（20:49）

补齐已确认的顶栏待确认告警数量角标。独立服务精确统计全部待确认活动（不受分页上限影响），与列表共用待确认筛选，排除已确认、误报和复核不支持的活动；查询有超时和索引。Web 后端保留登录鉴权。前端每 10 秒刷新，失败或无效结果显示未知，不冒充零；点击打开全部时间的待确认列表并清除旧筛选。不增加声音或推送。

最后版本回归：
- 前端 130 文件 / 1036 项通过，无跳过；含最后的焦点修改和角标。`test/results/alarm-review-final-frontend.log`。
- 控制台后端 68 文件 / 419 项通过，无跳过；实际隔离 PostgreSQL 和 MongoDB。`test/results/alarm-review-final-backend.log`。
- 独立服务冻结候选 106 项通过，无跳过；`test/results/alarm-review-final-service.log`。
- 前后端类型检查及构建通过。最终候选未部署。

新的唯一部署候选（替代本文前面的 review/review-final）：
- Web：`/mnt/ainvr-ssd/ainvr-alarm-refactor-web-20261020-badge`。
- 告警服务：`/mnt/ainvr-ssd/ainvr-alarm-refactor-service-20261020-badge`。
- Web 后端摘要：`1b6633e0c48fdb2add28b643e69dc482907ef5aacf8e1250db83f88a2c4ed5e5`。
- Web 前端摘要：`5c5560e882695649c86c3aa2d4bec820fa7b9cbe856d04c73bf6d9aa480721f4`。
- 告警产物清单摘要：`dcaeafe268b895a671c97a9f118629916591cd3468c120e950686354fd74d1a6`。

用新 Web 候选重新完成生产参数库只读备份、隔离恢复、迁移与业务配置回滚验证；未改变生产数据库。2 项部署失败编排测试也通过。
备份目录：`/mnt/ainvr-ssd/ainvr-alarm-refactor-backup-20261020-204713`；备份摘要：`55e7cda73e89341a2a7fb1918b46cfcd8e49efc2fcd6335482925491d70b1418`。证据 `test/results/alarm-refactor-backup-20261020.json`。

验收边界仍如前述：主要布防操作已在隔离浏览器验证，最终焦点修复与角标通过自动测试，未重新逐项浏览器验收；未验证 iPad 实机，全景坐标叠加仍是明确限制。部署需用户确认；不主动提交或推送。


## 最终全景补齐与冻结候选（21:10）

本节替代前文“全景不显示”的限制和旧 Web 候选。全景现在使用视频同一相机矩阵投影热区轮廓、轨迹与推算框；旋转视角时叠加随视频移动。热区保留原图边界语义，轨迹跨接缝取短路径，背面裁剪。全景仅绘制区域轮廓，不做球面填充；编辑仍在原始参考画面，判定坐标不变。

- 最终前端：132 文件、1041 项全部通过；类型检查、构建和 git diff --check 通过。日志 `test/results/alarm-panorama-final-frontend.log`。
- 本轮未修改后端及告警服务，沿用此前真实隔离数据库测试：Web 后端 419 项、告警服务 106 项通过，无跳过。
- 内置浏览器在隔离布防数据库配合真实现网视频中绘制区域、切换全景、拖动视角，确认轮廓、轨迹及推算框随视频正确投影。截图 `test/results/alarm-panorama-overlay.png`。浏览器所用 panorama 候选与最终候选应用代码相同，之后仅更新测试的新增参数断言。
- iPad 实机尚未验证；触摸事件自动测试不能替代实机验收。

唯一待部署组合：
- Web `/mnt/ainvr-ssd/ainvr-alarm-refactor-web-20261020-panorama-final`
- 告警服务 `/mnt/ainvr-ssd/ainvr-alarm-refactor-service-20261020-badge`
- Web 后端摘要 `1b6633e0c48fdb2add28b643e69dc482907ef5aacf8e1250db83f88a2c4ed5e5`
- Web 前端摘要 `b6b0f9dd9c5181e0ee77c734f16637b0091784650f4b96bb9f5a726249ebc490`
- 告警产物清单摘要 `dcaeafe268b895a671c97a9f118629916591cd3468c120e950686354fd74d1a6`

最终候选再次通过生产参数库只读备份、隔离恢复、迁移、幂等导入及回滚验证；历史与非告警表内容不变。备份 `/mnt/ainvr-ssd/ainvr-alarm-refactor-backup-20261020-210918`，SHA256 `7ceaa21ffc2c671ffa987814abfb99700aa2904e06f71eeedfd6dc932c1c1c27`。报告 `test/results/alarm-refactor-backup-20261020.json`。

未部署、未提交、未推送。按用户要求等待部署确认；获准后才切换控制台与独立告警服务，并核对实际规则版本、录像、推理、SEI 与观测积压。此次测试页面、夹具、隧道及专用数据库均已停止。


## 新增要求：360° 热区编辑与 ERP 双向一致（2026-10-20 21:44）

用户明确要求本期补齐全景投影，并新增全景直接编辑热区、切回 ERP 正确显示；同时核对检测框。此回复不构成部署批准。此前 panorama-final 候选没有全景编辑，不满足新增范围，不再作为本需求最终部署候选。

已完成的开发证据：
- `panoramaCoordinates.ts`：屏幕射线反算原始 ERP 坐标及可见顶点投影；检查无效矩阵、背面、越界与中心相机约束。
- 坐标往返测试覆盖 3 种宽高比、3 个 FOV、5 个水平角、3 个俯仰角、5 个屏幕点；以独立 Three.js 投影交叉核对。
- 原检测框纹理 UV 方向、裁剪、轨迹接缝测试共同 10 项通过，日志 `test/results/panorama-coordinates-green.log`。
- `PanoramaZoneCanvas.tsx` 与 ZoneEditor 接入静止全景参考图、显式调整视角/绘制模式、拖点及键盘移动；不创建第二路视频连接。编辑仍是本地草稿。
- 三项新增交互测试通过：释放前不提交、拖动中断还原、360 拖点后切 ERP 并保存仍为相同源坐标。日志 `test/results/panorama-editor-interaction.log`。该交互测试模拟 WebGL 输出，不等于浏览器视觉验收。
- 初步类型检查及原平面编辑 11 项回归通过；新增版本尚未跑全套三服务回归。

尚未完成，不能称为可部署：
1. 跨 ERP 左右接缝热区的显式几何契约。当前普通 points 多边形不能自动解释成跨缝小区域；需区分旧平面边界语义，不能静默改变历史区域。
2. 接缝契约必须贯穿草稿、存储、执行规则、2D 裁剪显示、360 投影及目标几何判定，且保留边 ID 和方向意义。只改前端最短边会造成显示与判定不一致，禁止采用。
3. 全景编辑整区移动、方向/边标识、播放器全景布防入口及触摸操作补齐；不要仅取消入口禁用就声称完成。
4. 真浏览器检验新建/拖点/保存/重新加载/360与ERP切换，覆盖接缝、不同俯仰和缩放；随后全套测试和重新冻结候选。

旧版本未部署，本轮也未改变现网服务、录像或推理。新增编辑组件当前为开发中实现，不能用此前 1041 项通过作为它的全量验收证据。
