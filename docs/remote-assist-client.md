# 远程协助（设备端）

客户在「系统配置 → 远程协助」开启后，设备主动连接中转服务器，技术支持经中转服务器远程登录本设备。设备免开通：安装包带统一接入凭据，设备以授权机器码为身份、首次开启时在本机生成设备令牌，开启后自动出现在中转管理页面。中转服务器代码在仓库 `relay-server/`。中转服务器部署见 [relay-server/README.md](../relay-server/README.md)，部署清单与远程维护操作见 [remote-assist-ops.md](remote-assist-ops.md)。

## 边界

- 只转发本机远程登录端口（读取 `sshd -T` 的实际端口，读不到就拒绝开启，不猜默认值）。不转发任何网页或接口端口：隧道进来的连接在本机表现为回环地址，而本机多个服务信任回环。
- 开关意图即 systemd 启用状态：开启 = `systemctl enable --now ainvr-remote-assist`，设备重启后自动恢复。关闭分两步：先 `disable` 取消自动连接，再 `stop` 停止进程，并以进程确实停止为准才报告"已关闭"；停止失败时页面显示"正在关闭"，提示仍可能被远程登录。
- 页面同时报告开关意图（enabled）与连接程序实际状态（running）；任一项查询失败显示"状态未知"，绝不默认为已关闭。顶栏提醒在之前显示过而本次查询失败时保留为"状态待确认"。
- 授权：控制台授权闸门已放行 `/api/remote-assist*`，授权失效时仍可在网页开关。
- 参数库：**已开启的隧道不依赖参数库，会继续运行；但网页开关要经过控制台登录校验，参数库不可用时网页无法操作**（登录校验故意在读不到密码时拒绝，不为此绕开）。此时用下方本机应急命令。
- 中转服务器平时只读，修改需再次输入管理员密码；开启、仍在运行或状态未知时拒绝修改。
- 必须校验中转服务器证书；统一凭据缺少接入令牌、隧道密钥或证书时拒绝开启。
- 机器码经本机授权服务读取（与授权页面一致），读到后缓存到状态目录；授权失效或授权服务异常时用缓存，从未读到过则拒绝开启（「暂时读不到本机机器码」）。远程协助不要求授权有效。
- 设备令牌 `device.key` 首次开启时生成并永久保存（root 0600，永不显示）；中转服务器按机器码记住它，之后同一机器码令牌不符即拒绝（「身份冲突」）。重装系统会生成新令牌，需供应商在管理页面重置身份。从旧版按设备签发凭据升级时沿用旧设备令牌，身份不变。
- 连接配置的 frp `user` 与隧道名都由机器码决定（`<机器码>-ssh`；隧道只允许同 user 的已登录访问者，堵住不登录的旧访问路径），携带设备身份（`metadatas.role/device/device_token`），并显式开启 10 秒心跳：中转服务器鉴权插件据此校验设备、约束隧道，并在云端暂停时于下一次心跳断开设备。
- 云端暂停时中转服务器回传固定标记 `AINVR_SUSPENDED`，页面显示「云端已暂停」（只认最近一次失败中的完整标记；其他失败按连接异常显示），客户开关保持不变，恢复后自动重连。身份冲突回传 `AINVR_IDENTITY_CONFLICT`，页面提示联系供应商重置。
- 已连接时页面分两层：无远程连接为「已连接 · 等待接入」；本机远程登录端口上有来自隧道的连接时为「正在远程操作（N 个远程连接）」并醒目提示可随时关闭，顶栏同步变红。连接数每次查询现算（页面每 5 秒、顶栏每 15 秒刷新），只在「已连接」时采信。页面同时显示本机机器码（四位一组），供客户与技术支持核对。
- 设备看不到「已被中转服务器设为当前工作设备」：被选中后、有人登录前不产生任何到设备的流量，不做这个显示。

## 组成

| 位置 | 作用 |
|---|---|
| `shared/os-helper/remote_assist.py` | 生成隧道配置、启停单元、状态与事件、连通性检测 |
| `srs-web-console/backend/src/routes/remoteAssist.ts` | 控制台接口，密码复验，只透传中文业务错误 |
| `srs-web-console/frontend/src/pages/ConfigCenter/RemoteAssistForm.tsx` | 页面；顶栏 `RemoteAssistIndicator` 在开启期间常显提醒 |
| `/etc/systemd/system/ainvr-remote-assist.service` | 由 install.sh 生成，`ainvr-assist` 无登录账号运行，默认不启用 |
| `/var/lib/ainvr-remote-assist/` | 状态目录（root:ainvr-assist 0750） |

## 统一接入凭据与本机身份

`/var/lib/ainvr-remote-assist/` 下（root 所有，页面永不显示内容）：

| 文件 | 内容 |
|---|---|
| `credentials.json`（0600） | 统一接入凭据，所有设备相同：`{"auth_token","secret_key","ca_cert","server_name"?}`。由中转服务器 `relayctl fleet` 导出，放到打包机 `deploy-package/vendor/remote-assist/`（不进仓库），`install.sh` 随包写入 |
| `server.json`（0600） | 中转服务器 `{"host","port"}`，随包写入（设备上已有时不覆盖）；管理员可在页面修改 |
| `device.key`（0600） | 本机设备令牌，首次开启时生成 |
| `machine_code`（0600） | 本机机器码缓存 |

未写入统一凭据时页面显示「接入凭据：未写入，请联系供应商」且无法开启。旧版按设备签发的 `credentials.json`（多出 `device_id`、`device_token`、`proxy_name`）仍可使用，其中设备令牌会被沿用为本机令牌。

## 隧道客户端程序

打包时把 arm64 客户端放到 `deploy-package/vendor/remote-assist/client`，并在同目录放 `client.sha256`（`sha256sum client > client.sha256`）。校验通过才随包，安装到 `/opt/ainvr/remote-assist/client`；缺失时照常出包，页面显示「组件未安装」。配置格式按 frp 0.52 及以上的 TOML 生成，换版本须重新验证。

## 本机应急操作（网页不可用时）

在设备本机或已登录的终端用管理员权限执行：

```bash
sudo systemctl disable ainvr-remote-assist && sudo systemctl stop ainvr-remote-assist   # 关闭
sudo systemctl is-enabled ainvr-remote-assist; sudo systemctl is-active ainvr-remote-assist  # 查看：应为 disabled / inactive
sudo systemctl enable --now ainvr-remote-assist   # 开启（需已写入中转服务器、凭据并在网页开启过一次以生成配置）
```

## 远程连接活动不是登录审计

页面的"当前远程连接"与「正在远程操作」按本机远程登录端口上的回环 TCP 连接数在每次查询时现算；记录里的"检测到远程连接 / 远程连接结束"每 15 秒采样一次。两者都会把未通过身份验证的连接、本机其他远程登录连接计入，记录可能漏掉短于采样间隔的连接，且都无法区分人员。人员登录记录以远程登录服务的认证日志（`journalctl -u ssh`）为准；如需按人审计，应为每位运维人员发放独立密钥并据此核对日志。

## 部署后验收

1. `systemctl cat ainvr-remote-assist` 存在且 `is-enabled` 为 disabled；页面显示本机机器码、「接入凭据：已写入」。
2. 「检测连通性」成功。
3. 开启 → 状态由「连接中」变为「已连接 · 等待接入」，顶栏出现提醒；`systemctl is-enabled` 为 enabled；中转管理页面按机器码出现这台设备。
4. 中转管理页面设为当前工作设备并登录后，页面变为「正在远程操作（1 个远程连接）」、顶栏变红，记录出现「检测到远程连接」；同时用 `journalctl -u ssh` 核对认证记录。
5. 关闭 → 已建立的远程连接立即断开，`systemctl is-active` 为 inactive，记录出现「关闭远程协助」；重启设备后保持关闭。另测一次停止失败（如临时让进程忽略退出信号），页面应显示「正在关闭」而不是「已关闭」。
6. 开启状态下重启设备 → 自动恢复「已连接」。

2026-10-08 已在开发板上实测：os-helper 内启停单元、客户端加载生成的配置、读取 `sshd -T` 端口、经授权服务读取机器码、换为统一凭据后以原身份重新连上。
