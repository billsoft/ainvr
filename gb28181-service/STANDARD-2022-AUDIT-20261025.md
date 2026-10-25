# GB/T 28181—2022 摄像头接入条款核对（2026-10-25）

## 结论与证据边界

本轮完成摄像头接入核心条款的定向核对，修复三个问题；不是全标准逐条符合性认证，也不是厂商真机验收。此前“未取得可读正式全文”的来源缺口已有进展：官方在线预览可读，共 166 页。不能把可读取全文写成已经核验全部条款。

正式依据：国家标准全文公开系统 https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=8BBC2475624A6C31DC34A28052B3923D 。本轮直接查看官方封面、6.10、附录 J 首页、附录 K 正文及附录 L。其他定位使用可检索的 166 页公开副本，尚未逐页与官方影像比对。

定位副本：https://github.com/tonyonce2017/GB28181-2022/releases/download/v1.0/GBT.28181-2022.pdf ，SHA256 748be3dc0ad1ebd0b7ae7af86c82d7294cfd03691818f8bea197399f208302cc。副本及全文提取不入产品仓库。SRS 网站的 161 页文件封面为报批稿，不能代替正式版；正式版目录与附录 K 正文的属性标记存在不一致；2026-10-25 已直接核对官方第 150 页，正文明确标注规范性。本项目按规范性处理 K，不能依目录将其降为资料性。附录 H 为资料性。

## 已核对与修复

|条款／范围|代码与参考对照|结论|
|---|---|---|
|6.10 字符集|protocol.go QueryXMLForProfile|2022 查询声明 GB18030；2016 声明 GB2312。目前生成内容全为 ASCII，字节兼容；未来中文字段必须实际编码，不能只改声明。|
|附录 I 版本协商|SelectVersion、响应头、已有 compatibility_test|自动模式按明确声明选择；无声明采用 2016 并保持未确认。正式配置与对端声明分开，不把人工选择当作协商证据。附录 I 尚需官方影像逐项复核。|
|附录 J 目录节点／附录 M 分批|catalog.go、protocol.go；WVP CatalogResponseMessageHandler|修复行政区短编号导致整批目录拒绝。结构节点参与 SumNum 完整性计算，完成后过滤行政区、系统、业务组、虚拟组织，不导入视频输入。|
|附录 L Subject|session.go；WVP SIPRequestHeaderProvider|修复来源序列随媒体 SSRC 变化。当前单通道默认实时流使用稳定来源序列 0，接收序列由媒体租约区分。WVP 的 SSRC 写法不作为规范依据。未来多码流必须扩展来源身份。|
|9.1 注册|server.go、先前 compatibility_test；WVP RegisterRequestProcessor|Contact expires 优先级、鉴权及版本状态已有回归；接受短有效期属于兼容策略，不宣称覆盖设备端全部规范。TCP 连接关闭与离线时机仍需专门集成验证。|
|9.2、附录 G 点播|session.go、sdp.go；WVP SIPCommander / InviteResponseProcessor|检查 INVITE、ACK、BYE、setup / connection / SSRC 主链路。不能据此推定所有厂商 SDP 变体通过。|
|附录 D、K 媒体生命周期|media.go、manager.go；ZLMediaKit RtpServer / RtpSession|参考实现覆盖 RTP 接收、SSRC 与 RTCP；网关具有会话恢复。TCP 同一会话内重连次数和间隔、媒体保活仍需独立报文与故障注入核验。|

新增 standard_audit_test.go 覆盖：重连来源身份稳定、接收身份区分、双版本字符集、混合结构目录完成后只导出视频候选、非法节点编号拒绝。

## 固定开源参考

只读引用，不更新子模块，也不把开源行为等同于标准。

- WVP：third_party/reference/wvp-GB28181-pro，2b656f4e55147f2377986a878da01a98ae564fe5，https://github.com/648540858/wvp-GB28181-pro 。本轮查看注册、目录响应、INVITE 构造和响应处理。
- ZLMediaKit：third_party/reference/ZLMediaKit，bb83e697a60ad9dde679afcd7b85feeafdf7514b，https://github.com/ZLMediaKit/ZLMediaKit 。本轮查看 RtpSession / RtpServer 的 SSRC、TCP 分帧与 RTCP 处理。

## 尚不能标记完成的事项

- 166 页官方影像与副本逐页一致性、所有适用规范性条款逐条用例追溯尚未完成；本表是接入核心核对，不是完整符合性矩阵。
- SDP 对缺省 rtpmap 等设备变体的兼容性，TCP 断链注册状态、同一媒体会话 TCP 重连策略，仍需独立验证。
- 资源限制（例如 XML 256 KiB）是产品边界；不能把能发现大量目录等同于支持任意单包目录大小或任意并发。
- 标准包含本期之外的云台、对讲、历史录像查询、级联、订阅等业务；本期不实现，不宣称完整标准认证。
- 厂商 2016／2022 真机、音视频同步和长期容量验收继续待完成；本次单元回归不能替代。

验证：Go 全包 race 测试和 go vet 通过。本轮未修改既有相机配置、SRS 或前端交互，未提交或推送。


## 本轮继续完善（2026-10-25 晚）

- SDP 接受标准允许的缺省 PS rtpmap 和 RFC 默认方向；仍拒绝显式不兼容映射、接收端方向、重复矛盾属性、未经授权媒体地址及 SSRC。
- TCP 信令以已认证连接身份判断在线，不再单靠心跳期限；断开后重新连接不能继承原连接注册身份。独立 socket 测试覆盖两版。
- TCP 主动媒体连接在同一租约下最多三次尝试、间隔至少一秒；取消不继续尝试。
- XML 拒绝重复的路由／相关性／目录完成控制字段，避免解析器的后值覆盖行为。
- 不使用缓存的全包 Go race、vet 和 ARM64 构建通过；XML 模糊测试 30 秒 113386 次、SDP 30 秒 55497 次，通过。这是有界健壮性测试，不代表穷尽输入空间。
- coverage-2022.json 建立 48 组条款/附录覆盖记录；这是分组清单，不是逐规范句完成的认证矩阵。check_coverage.py 明确报告缺口，不能用条目数自动宣布完成。
- 6.3 的 PS 存储与现有 MP4 存储、8.3 的 Note 信令摘要与现有注册鉴权存在明确差异，不标为符合；保留已授权的实时接入产品范围，不擅自替换录像架构。

最终候选媒体验证已排队，等待既有 24 小时测试释放互斥锁。候选网关哈希：62b4c08dce584e644cd39f0a914fa851f7596d49a7bed4aba0f808f906c80329。依次运行 96 组合、生产录像命令验证、四路两小时、两路 24 小时；任一失败停止。所有结果与网关哈希绑定，旧结果不计为新构建通过。

运行日志：out/gb28181/acceptance-20261025-final/run.log；进程标识和源码哈希在同目录。脚本 test/gb28181/acceptance.sh 使用独立测试组件与端口。生产默认关闭配置保持，尚未部署本轮候选；未提交或推送。不能将当前状态表述为“除真机外全部完成”。


最终增量：按 A.2.5.2 接受 ERROR 故障心跳并保留在线身份，正常心跳清除对应故障；拒绝非法查询结果、零序号和缺失目录总数。25 个顶层测试及其子用例通过 race；vet、构建通过。旧候选排队尚未开始，已取消并保留记录，改为 acceptance-20261025-v2 队列。最终哈希 2abbe2c5b0c4f8665db8ecbe6cb8291450c724ab2a2e04b76193e396d41d22ed。最终目录 out/gb28181/acceptance-20261025-v2/，日志 run.log，PID 文件 pid。
