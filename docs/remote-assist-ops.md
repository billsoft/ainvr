# 远程协助运维手册

公司内部使用：中转服务器部署、管理页面、设备部署、日常远程维护、云端暂停与恢复、排障与回滚。**本文不含任何密码、令牌或密钥**，只写它们存放的位置；不要随设备软件包发给客户。

相关文档：设备端设计与凭据格式 [remote-assist-client.md](remote-assist-client.md)；中转服务器脚本与命令 [relay-server/README.md](../relay-server/README.md)。

## 1. 链路与原则

```
公司电脑 ──ssh -J──▶ 腾讯云 127.0.0.1:6000（当前工作设备入口 ainvr-relay-work）
                         │ 中转 frps :33888 + 鉴权插件（机器码身份 / 暂停）
客户设备 隧道 frpc ──TLS──┘ ──▶ 设备 sshd
```

- **设备免开通**：安装包里带一份所有设备相同的**统一接入凭据**。客户在设备页面开启远程协助后，设备按**授权机器码**连上中转服务器，自动出现在管理页面。
- **设备身份**：设备首次开启时在本机生成**设备令牌**（root 0600，永不显示）。鉴权插件在该机器码第一次出现时记住令牌（只存哈希），之后同一机器码令牌不符即拒绝，显示「身份冲突」。拿到安装包的人因此无法冒用在线设备的机器码。客户重装系统后显示冲突时，在页面「重置设备身份」。
- **当前工作设备**：运维在管理页面把一台在线设备设为当前工作设备，云服务器本机 `127.0.0.1:6000` 就指向它；切换后同一个入口指向另一台。入口只监听云服务器本机，不对公网开放。
- **隧道约束**：中转服务器不对公网开放任何设备的登录端口（STCP），只转发设备本机远程登录端口。设备只能注册 `<机器码>-ssh` 隧道，且不能放宽访问者范围（`allow_users` 只能为空或本机机器码）。
- **身份绑定**：设备与工作入口的 frp `user` 都是机器码（中转面板里隧道名显示为 `机器码.机器码-ssh`）。frp 只允许与隧道同 user 的访问者，不经登录的旧访问路径（user 为空）被拒绝。
- **心跳**：设备每 10 秒心跳，插件每次复查身份与暂停。中转服务端心跳超时 40 秒，心跳被拒或不发心跳的客户端（包括无视拒绝的改造客户端）由服务端主动断开。
- **读不到即拒绝**：`auth.json` 缺失或损坏时拒绝全部接入；设备身份表读不到时拒绝全部设备，并且**绝不从空表重新记住**（否则冒用者可趁机占位）。恢复后自动放行。
- **能否远程维护 = 客户在设备页面开启 + 云端允许该设备 + 被设为当前工作设备。**云端暂停/恢复不会改动客户的开关，也不影响设备录像、识别和授权。

| 客户开关 | 云端 | 设备页面 |
|---|---|---|
| 关闭 | 任意 | 已关闭 |
| 开启 | 允许，无人登录 | 已连接 · 等待接入 |
| 开启 | 允许，有人经隧道登录 | 正在远程操作（N 个远程连接） |
| 开启 | 暂停 | 云端已暂停（恢复后自动连接） |
| 开启 | 身份冲突 | 连接失败：本机身份与登记不一致，请联系供应商 |
| 开启 | 鉴权服务故障、网络不通等 | 连接失败（中文原因） |

设备上看不到「已被设为当前工作设备」：这个设置只存在于中转服务器上，被选中后、有人真正登录前不产生任何到设备的流量。设备能准确显示的是「正在远程操作」，依据本机远程登录端口上来自隧道的实时连接数。

## 2. 当前部署清单（2026-10-08）

| 项 | 值 |
|---|---|
| 中转服务器 | 域名 **`relay.gpling.com`**（DNSPod 单条 A 记录，TTL 600）→ 腾讯云 `43.163.66.62`，Ubuntu 24.04，2 核 3.6GB，登录 `ubuntu@relay.gpling.com -p 22`（密码由负责人保管）。**设备、运维入口、证书都按域名**，更换服务器只需迁移状态并改这条解析（第 14 节）。`gpling.com`/`www` 是轮询到两台机器的网站解析，不能用于中转 |
| 中转端口 | TCP `33888`（本机 ufw 与云平台安全组均已放行） |
| 中转服务 | `ainvr-relay.service`（frp 0.71.0，`/opt/ainvr-relay/frps`，账号 `ainvr-relay`） |
| 鉴权插件 | `ainvr-relay-auth.service`（`/opt/ainvr-relay/relay_auth.py`，仅监听 `127.0.0.1:7600`，账号 `ainvr-relay`）；设备身份表 `/var/lib/ainvr-relay-auth/identities.json`（插件唯一写入，0600） |
| 当前工作设备入口 | `ainvr-relay-work.service`（`/opt/ainvr-relay/frpc -c /etc/ainvr-relay/work.toml`），只监听云服务器 `127.0.0.1:6000`；未选定工作设备时不运行 |
| 管理命令 | `/usr/local/sbin/relayctl`（仅 root） |
| 管理页面 | `https://relay.gpling.com:8181`（IP 也可），`ainvr-relay-web.service`（`/opt/ainvr-relay/relay_web.py`，账号 `ainvr-relay-web`，只能经 sudo 白名单执行 relayctl）；状态 `/var/lib/ainvr-relay-web/`（`admin.json` 密码哈希、`setup.code` 初始化码、`tls/`）；本机 ufw 与云安全组已放行 8181；管理员密码已设置 |
| 配置与状态 `/etc/ainvr-relay/` | `frps.toml`；`token`（frp 接入令牌）；`fleet.json`（统一隧道密钥与服务器地址，root 0600）；`relay.token`（工作入口令牌，root 0600）；`work.toml`（当前工作入口配置）；`auth.json`（插件读取：暂停标志、身份重置时间、工作入口令牌哈希）；`labels.json`（备注）；`dashboard.pass`；`tls/`；`ca/`（CA 私钥，仅 root）；`audit.log` |
| 统一接入凭据导出 | `sudo relayctl fleet` 写到 `/root/ainvr-relay-fleet/`（`credentials.json`、`server.json`）；页面「统一接入凭据」可下载 |
| frps 自带面板 | 仅服务器本机 `127.0.0.1:7500`（管理页面经 relayctl 读取它） |
| 开发板 | `ainvr-nvr`，机器码 `X3TZ-MPW0-TWQJ-X9MH-7NWX-M0MM`，已换为统一接入凭据（旧版按设备签发的设备令牌沿用为本机令牌，身份不变） |
| 设备端 | 客户端 `/opt/ainvr/remote-assist/client`（frpc 0.71.0 arm64），单元 `ainvr-remote-assist.service`（账号 `ainvr-assist`），状态目录 `/var/lib/ainvr-remote-assist/`（`credentials.json` 统一凭据、`server.json`、`device.key` 本机令牌、`machine_code` 机器码缓存），设备登录端口 33888 |
| 升级备份 | 免开通改造前的中转配置 `/root/ainvr-relay-conf-backup-20261008-151327`；开发板旧凭据 `/root/remote-assist-credentials-legacy-backup.json` |

**这台云服务器上还运行着其他业务**（nginx:80、占用 443/2053 的代理、docker:1124、warp 等），维护时只操作 `ainvr-relay*` 相关内容，不要改动其他服务和防火墙规则；80、8080、8433、8443 端口不可用。

## 3. 中转服务器部署与升级

在云服务器上（需要 sudo），把仓库 `relay-server/` 下的 `install-relay.sh`、`relay_auth.py`、`relayctl.py`、`relay_web.*` 放在同一目录：

```bash
V=0.71.0
curl -fsSLO https://github.com/fatedier/frp/releases/download/v$V/frp_${V}_linux_amd64.tar.gz
curl -fsSLO https://github.com/fatedier/frp/releases/download/v$V/frp_sha256_checksums.txt
sudo bash install-relay.sh --public-ip <公网IP> --domain relay.gpling.com --tarball frp_${V}_linux_amd64.tar.gz --checksums frp_sha256_checksums.txt --port 33888
```

- 可重复执行，成功返回 0：令牌、CA、统一隧道密钥只生成一次；公网 IP 变化时重签服务端证书；程序原子替换后重启服务（中转重启时在线设备几秒内自动重连）。
- 从按设备开通的旧版升级时：设备身份表由旧设备令牌哈希生成，`auth.json` 转为新格式（保留暂停），备注迁到 `labels.json`；已上线设备无感知。旧 `devices.json`、`operators.json` 不再使用，可人工归档。
- 升级前先备份：`sudo cp -a /etc/ainvr-relay /root/ainvr-relay-conf-backup-$(date +%Y%m%d-%H%M%S)`。
- 验证：`systemctl is-active ainvr-relay-auth ainvr-relay ainvr-relay-web`；`sudo relayctl list`。
- `--domain`：证书同时签域名与 IP（按 IP 下发过的旧凭据继续有效），统一接入凭据、管理页面导出、工作入口登录命令都用域名。省略时退回按 IP。
- 更换服务器见第 14 节（必须迁移 CA 与状态，**不要**在新服务器上从零安装，否则已出货设备全部失效）。

## 4. 管理页面（https://relay.gpling.com:8181）

日常操作推荐用页面；页面与 `relayctl` 是同一套逻辑（页面的每个操作都调用 `sudo relayctl`），**页面不可用时命令行可完成全部操作**。

**首次使用**（已完成）
1. 在服务器上取初始化码：`sudo cat /var/lib/ainvr-relay-web/setup.code`（只有 root 能看）。
2. 浏览器打开页面。证书由自建 CA 签发，浏览器会提示不受信任：可把 CA 证书（服务器 `/etc/ainvr-relay/tls/ca.crt`）导入「受信任的根证书颁发机构」，或核对指纹后继续访问。CA 证书 SHA-256 指纹：`00:24:2D:B6:EE:6E:13:8E:E9:56:EE:C5:C3:57:74:B3:3F:04:7E:04:6A:F4:24:F8:79:B7:33:0B:D0:AC:F7:61`。
3. 输入初始化码，设置管理员密码（至少 10 个字符）。忘记密码在服务器执行 `sudo relayctl web-reset`（已登录的浏览器立即失效，并生成新初始化码）。

**页面能做的事**

| 位置 | 操作 |
|---|---|
| 顶栏 | 中转服务、鉴权插件运行状态，设备身份表不可读时红色提示；修改密码；退出 |
| 当前工作设备横幅 | 当前工作设备名称、入口是否就绪、设备是否在线；**复制登录命令**；结束工作 |
| 概览 | 在线设备、出现过的设备、已暂停、身份冲突数量；全部暂停时红色横幅，可一键解除 |
| 设备 | 搜索（机器码，可带横杠，或备注）、按在线/离线/已暂停/身份冲突筛选；每台显示备注、机器码、云端状态（允许/暂停/身份冲突）、在线状态与公网 IP、主机名、维护连接数、今日流量；**设为当前工作 / 结束工作**、**暂停（踢下线）/ 重新允许**；更多：修改备注、重置设备身份、强制断开；统一接入凭据下载；全部暂停 |
| 在线连接 | 当前连到中转服务器的设备与工作入口（身份、公网 IP、主机名、连接时间）；可对设备暂停 |
| 操作记录 | 页面与命令行的全部管理操作（时间、操作人、动作、对象、原因）；页面操作的操作人记为「网页@来源 IP」 |

**安全**：HTTPS；scrypt 密码哈希；登录失败 5 次锁定 5 分钟（全站 30 次）；会话 HttpOnly + Secure + SameSite=Strict，空闲 2 小时、最长 12 小时失效，改密或服务器重置后全部失效；写操作校验 CSRF 令牌与来源；严格内容安全策略；页面服务账号只能执行 relayctl。下载的统一接入凭据含密钥，只经受控渠道传递。

## 5. 统一接入凭据（一次性，随安装包下发）

```bash
sudo relayctl fleet          # 写到 /root/ainvr-relay-fleet/：credentials.json、server.json
```

- 把两个文件放到打包机 `deploy-package/vendor/remote-assist/`（已加入 `.gitignore`，不进仓库），与 `client`、`client.sha256` 放在一起；`build-release.sh` 随包带上，`install.sh` 写入设备 `/var/lib/ainvr-remote-assist/`。
- 所有设备相同；重复导出不会更换密钥，已出货设备继续可用。
- `credentials.json` 含 frp 接入令牌、统一隧道密钥与 CA；`server.json` 为中转服务器地址端口（只在设备上缺失时写入，不覆盖管理员在设备页面的修改）。

## 6. 设备端部署

### 6.1 新装或升级（离线包）

打包前在 `deploy-package/vendor/remote-assist/` 放好：frpc arm64 `client` 与 `client.sha256`，以及第 5 节的 `credentials.json`、`server.json`。`install.sh` 依次：

- 安装客户端（原子替换），创建 `ainvr-assist` 账号、状态目录和 `ainvr-remote-assist` 单元（默认不启用）；
- 写入统一接入凭据。从旧版按设备签发凭据的设备升级时，先把旧凭据里的设备令牌沿用为本机令牌（`device.key`），身份不变，不会显示冲突。

新设备不需要任何开通步骤：客户在「系统配置 → 远程协助」打开开关，设备读取本机机器码、生成本机令牌后连上中转服务器，管理页面随即出现这台设备。

### 6.2 已上线设备手工补装

设备访问 GitHub 很慢，客户端安装包可先在中转服务器下载并按官方校验和核对，再经运维电脑传到设备。在设备上以 root 执行：

```bash
V=0.71.0; cd /tmp/ra-frp   # 已放入 frp_${V}_linux_arm64.tar.gz 与 frp_sha256_checksums.txt
grep " frp_${V}_linux_arm64.tar.gz$" frp_sha256_checksums.txt | sha256sum -c -
tar xzf frp_${V}_linux_arm64.tar.gz
install -d -m 0755 /opt/ainvr/remote-assist
install -m 0755 frp_${V}_linux_arm64/frpc /opt/ainvr/remote-assist/.client.new
mv -f /opt/ainvr/remote-assist/.client.new /opt/ainvr/remote-assist/client
getent group ainvr-assist >/dev/null || groupadd --system ainvr-assist
id -u ainvr-assist >/dev/null 2>&1 || useradd --system --gid ainvr-assist --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin ainvr-assist
install -d -o root -g ainvr-assist -m 0750 /var/lib/ainvr-remote-assist
# 单元文件内容与 deploy-package/install.sh 中 ainvr-remote-assist.service 段一致
install -o root -g root -m 0600 credentials.json /var/lib/ainvr-remote-assist/credentials.json   # 第 5 节统一凭据
install -o root -g root -m 0600 server.json      /var/lib/ainvr-remote-assist/server.json
systemctl daemon-reload
systemctl restart ainvr-os-helper     # 加载远程协助模块（约 1–2 秒，只影响网络管理接口）
```

已开启过的设备换凭据后，在设备页面关闭再开启一次，以重新生成连接配置。控制台页面需重建前后端容器后可见（见第 11 节）。

## 7. 远程维护：当前工作设备

**前提**：客户已开启，设备页面「已连接」，管理页面里该设备「在线」且云端「允许」。

1. 先和客户核对机器码：客户在设备「系统配置 → 远程协助」看到「本机机器码」，与管理页面设备行一致。
2. 管理页面对该设备点「设为当前工作」（命令行 `sudo relayctl work <机器码>`，机器码可带横杠）。约 5 秒后入口就绪。
3. 在公司电脑执行页面横幅里的命令（「复制登录命令」）：

```bash
ssh -J ubuntu@relay.gpling.com -p 6000 -o HostKeyAlias=ainvr-<机器码> ainvr@127.0.0.1
```

   先输入云服务器密码，再输入设备密码。`HostKeyAlias` 让 ssh 按机器码分别记住各设备的主机密钥：同一个 `127.0.0.1:6000` 切换设备后主机密钥会变，不加这个参数 ssh 会拒绝连接。首次登录某台设备时 ssh 会询问是否信任该主机密钥。
4. 换另一台：直接对它点「设为当前工作」，原工作设备上经入口建立的会话会断开，设备本身保持在线。
5. 用完点「结束工作」（`sudo relayctl work --clear`），入口关闭。

也可以先登录腾讯云，再在云上执行 `ssh -p 6000 -o HostKeyAlias=ainvr-<机器码> ainvr@127.0.0.1`。

**确认登录的是哪台**：登录后 `hostname`，或设备上 `echo $SSH_CONNECTION`（经隧道时对端为 `127.0.0.1`）。客户设备页面会显示「正在远程操作（N 个远程连接）」，顶栏变红。这是按连接数统计，不是登录审计；人员登录以设备 `journalctl -u ssh` 为准。

**谁能用入口**：能登录腾讯云 `ubuntu` 账号的人。需要按人分配或停用时，应在云服务器上建专用跳板账号（只允许转发到 `127.0.0.1:6000`），这要修改云服务器 SSH 配置，属于生产变更，需负责人同意后实施。

## 8. 云端暂停与恢复（客户占用、异常设备、紧急停止）

页面「设备」页的「暂停（踢下线）/ 重新允许」与「全部暂停」按钮对应下列命令（机器码可带横杠）：

```bash
sudo relayctl list                                  # 设备、云端状态、在线情况、当前工作设备（★）
sudo relayctl suspend <机器码> --reason "原因"       # 暂停单台
sudo relayctl suspend --all --reason "原因"          # 全部暂停
sudo relayctl resume <机器码>                         # 恢复单台
sudo relayctl resume --all                           # 解除全部暂停（不解除单台暂停）
sudo relayctl suspend <机器码> --hard                # 紧急：暂停并立即断开该设备公网 IP 的连接（不重启中转）
sudo relayctl suspend --all --hard                   # 全部暂停并重启中转服务，所有连接立即断开
```

暂停不需要设备事先出现过：可以按机器码预先暂停。2026-10-08 在开发板与 30 台模拟设备上实测（按设备开通版本，暂停与断开机制未变）：

| 操作 | 结果 |
|---|---|
| 单台暂停（正常客户端） | 已建立的维护会话约 3–10 秒内断开（下一次心跳）；设备页面约 4 秒显示「云端已暂停」；新连接被拒；客户开关不变 |
| 恢复单台 | 设备约 5–17 秒自动重连（客户端带退避与随机延迟） |
| 全部暂停 30 台 | 2.6 秒内全部断开 |
| 解除全部暂停 30 台 | 17.3 秒内全部连回，重连分散在第 10–17 秒，无同时冲击 |
| 单台 `--hard` | 只断开该设备当前公网 IP 到中转的连接，**不重启中转**，已有会话 0 秒断开、其他设备不受影响；同一公网 IP 后面的其他设备会被一并断开并几秒内自动重连；拿不到 IP 或断开失败时退回重启中转 |
| `--all --hard` | 重启中转服务，所有连接立即断开；未暂停的设备几秒内自动重连 |
| 鉴权插件停止 | 在线设备约 3–4 秒内被断开（fail-closed），页面提示「中转服务器鉴权暂不可用」；插件恢复后约 5 秒连回 |

- 正常客户端在下一次心跳（约 10 秒）断开；无视拒绝的改造客户端由中转服务端 40 秒心跳超时断开（实测同一客户端每 40 秒超时、重登循环，握不住稳定会话）；需要立即断开用 `--hard`。
- 暂停状态持久化在 `auth.json`，中转服务或插件重启后仍生效。
- 每次管理操作记录在 `/etc/ainvr-relay/audit.log`。

## 9. 设备身份冲突与重置

- **现象**：管理页面该设备「身份冲突」，显示被拒的公网 IP 与时间；设备页面「中转服务器上登记的本机身份与当前不一致」；中转日志 `AINVR_IDENTITY_CONFLICT`。
- **正常原因**：客户重装系统、更换存储，或删除了 `/var/lib/ainvr-remote-assist/device.key`，设备生成了新令牌。
- **异常原因**：有人用安装包里的统一凭据冒用这台设备的机器码。此时真设备通常仍在线，**不要重置**。
- **处理**：与客户确认是重装等正常原因后，页面「更多 → 重置设备身份」（`sudo relayctl reset <机器码>`）。下一台以该机器码连上来的设备会被重新记住，旧令牌此后被拒。
- **局限**：如果有人抢在真设备第一次连上之前冒用了它的机器码，真设备会显示冲突；按上述方法确认后重置。设备身份表最多记 20000 台，超出后新设备被拒。

## 10. 日常检查

| 位置 | 命令 |
|---|---|
| 中转、插件、入口与页面 | `systemctl is-active ainvr-relay-auth ainvr-relay ainvr-relay-web`；`systemctl is-active ainvr-relay-work`（只在有当前工作设备时为 active）；`sudo journalctl -u ainvr-relay-auth -n 50`（拒绝记录同类 60 秒内只记一次；记住新设备会记一条） |
| 在线设备 | `sudo relayctl list`；管理面板：`ssh -L 7500:127.0.0.1:7500 ubuntu@relay.gpling.com` 后浏览器开 `http://127.0.0.1:7500`（用户 admin，密码见 `/etc/ainvr-relay/dashboard.pass`） |
| 设备隧道 | `systemctl is-enabled ainvr-remote-assist; systemctl is-active ainvr-remote-assist`；`journalctl -u ainvr-remote-assist -n 50` |
| 设备配置校验 | `sudo /opt/ainvr/remote-assist/client verify -c /var/lib/ainvr-remote-assist/client.toml` |

## 11. 设备本机应急与控制台回滚

- 网页不可用时在设备本机：`sudo systemctl disable ainvr-remote-assist && sudo systemctl stop ainvr-remote-assist`（关闭）；`sudo systemctl enable --now ainvr-remote-assist`（开启，需开启过一次以生成配置）。
- 控制台页面部署（设备 `srs-web-console/`）：先 `docker tag ...:latest ...:pre-<标记>` 备份，再 `docker compose build backend frontend && docker compose up -d --no-deps --force-recreate backend frontend`。
- 回滚标签：`pre-remote-assist-20261008`（远程协助上线前）、`pre-relay-gate-20261008`（按设备鉴权前）、`pre-fleet-20261008`（免开通与「正在远程操作」显示前）：

```bash
T=pre-fleet-20261008
docker tag srs-web-console-backend:$T  srs-web-console-backend:latest
docker tag srs-web-console-frontend:$T srs-web-console-frontend:latest
docker compose up -d --no-deps --force-recreate backend frontend
```

- 中转服务器回滚到免开通改造前：停止 `ainvr-relay-work`，用 `/root/ainvr-relay-conf-backup-20261008-151327` 还原 `/etc/ainvr-relay`，并部署对应版本的 `relay-server/` 代码后重跑安装脚本。旧版需要设备按设备签发的凭据，开发板旧凭据见第 2 节备份。

## 12. 排障

| 现象 | 先查 |
|---|---|
| 管理页面打不开 | `systemctl status ainvr-relay-web`；云安全组是否放行 8181；用命令行 `sudo relayctl` 照常操作 |
| 管理页面忘记密码 | 服务器执行 `sudo relayctl web-reset`，用新初始化码重新设置 |
| 客户已开启，管理页面看不到设备 | 设备页面是否「已连接」；设备是否装了统一接入凭据（设备页面「接入凭据：已写入」）；搜索时机器码可带横杠 |
| 「设为当前工作」报「还没有连上来过」 | 该机器码从未成功连上；先让客户开启远程协助 |
| 横幅「入口未运行」 | `systemctl status ainvr-relay-work`；`journalctl -u ainvr-relay-work -n 50` |
| `ssh -p 6000` 报 REMOTE HOST IDENTIFICATION HAS CHANGED | 忘了加 `-o HostKeyAlias=ainvr-<机器码>`；用页面复制的完整命令 |
| `ssh -p 6000` 连上但很快断开或无响应 | 设备是否在线且未暂停；当前工作设备是否刚被切换；`journalctl -u ainvr-relay-work` 是否有 `start visitor success` |
| 身份冲突 | 见第 9 节 |
| 页面「中转服务器鉴权暂不可用」 | `systemctl status ainvr-relay-auth`；`/etc/ainvr-relay/auth.json` 是否可读；`/var/lib/ainvr-relay-auth/identities.json` 是否存在且可被 ainvr-relay 读写（缺失即拒绝全部设备，从备份还原，不要新建空表） |
| 页面「云端已暂停」 | `relayctl list` 是否该设备或全部处于暂停；需要时 `resume` |
| 页面「中转服务器不认可本设备凭据」 | 设备统一接入凭据是否完整、是否为当前中转服务器导出 |
| 页面「暂时读不到本机机器码」 | 设备授权服务是否运行（`systemctl status ainvr-license`）；读到过一次后会缓存 |
| 页面「连接中转服务器超时」 | 设备出站 33888 是否被客户防火墙拦截：`timeout 5 bash -c "</dev/tcp/<IP>/33888"`；云安全组 |
| 页面「中转服务器证书校验失败」 | 服务器是否重装或换了 CA |
| 页面「组件未安装」 | `/opt/ainvr/remote-assist/client` 与单元文件是否存在 |
| 登录提示密码错误 | 第一个密码是云服务器的，第二个是设备本机 sshd 的，与中转无关 |
| 云服务器短时间多次 SSH 后连不上 | 云主机安全组件可能限流，稍候重试 |

## 13. 容量与已知限制

- 实测：每台在线设备约占中转服务 160KB 内存，30 台在线时 CPU 约 0.2%；鉴权插件单进程约 850–890 次/秒（同机压测，p99 约 12ms），按每台 10 秒一次心跳折算，1000 台约用插件 12% 处理能力。以上是 30 台实测加推算，更大规模上线前应按实际台数再压测；轻量服务器另需关注月流量。
- 统一接入凭据随安装包分发，应视为可能泄露：它只能让设备连上中转服务器，冒用已出现设备的机器码会被身份校验拒绝；能做的最坏情况是抢先占用尚未连上过的机器码（真设备显示冲突，按第 9 节处理），或注册无用的新机器码（身份表上限 20000）。
- 同一时间只有一台当前工作设备。
- 出现过的设备会一直留在列表中（没有删除命令）。
- 远程入口的访问控制是腾讯云 SSH 账号本身，目前只有 `ubuntu` 账号；按人分配需建专用跳板账号（见第 7 节）。
- 设备当前允许密码登录 SSH；正式交付前改为仅密钥登录。
- CA 私钥存放在中转服务器上；规模化后应迁出到离线签发环境。
- 管理页面只有一个管理员账号（多人共用一个密码），操作记录区分来源 IP 不区分人；这台服务器若经代理转发，来源 IP 可能都显示为服务器自身地址，此时按 IP 的登录锁定等同于全站锁定。

## 14. 更换中转服务器（迁移）

原则：**搬状态，不重新生成**。CA、接入令牌、统一隧道密钥写在每台已出货设备的凭据里，设备身份表记着每台设备的令牌；在新服务器上从零安装会让它们全部失效。设备按域名 `relay.gpling.com` 连接，所以迁移完成后只改解析，设备自动连到新服务器，客户侧无需任何操作。

**需要迁移的状态**（含 CA 私钥与全部密钥，只经 scp 等受控通道传输，用完删除副本）：

| 位置 | 内容 |
|---|---|
| `/etc/ainvr-relay/` | CA（`ca/`）、`tls/`、`token`、`fleet.json`、`relay.token`、`auth.json`（暂停与身份重置）、`labels.json`、`dashboard.pass`、`audit.log` |
| `/var/lib/ainvr-relay-auth/identities.json` | 设备身份表（缺失即拒绝全部设备，绝不能用空表代替） |
| `/var/lib/ainvr-relay-web/` | 管理页面密码（不迁移则首次打开需重新初始化） |

**步骤**

1. 新服务器准备：Ubuntu，云安全组放行 TCP 33888 与 8181；确认这两个端口未被其他业务占用。按第 3 节下载 frp 安装包，并把仓库 `relay-server/` 下的文件放到同一目录。
2. 在新服务器先安装一次，用于创建账号与服务：
   ```bash
   sudo bash install-relay.sh --public-ip <新公网IP> --domain relay.gpling.com --tarball ... --checksums ...
   sudo systemctl stop ainvr-relay-work ainvr-relay ainvr-relay-auth ainvr-relay-web
   ```
3. 旧服务器导出状态。先停服务，保证身份表不再变化；停服期间设备显示连接失败并自动重试：
   ```bash
   sudo systemctl stop ainvr-relay-work ainvr-relay ainvr-relay-auth ainvr-relay-web
   sudo tar czpf /root/ainvr-relay-state.tgz /etc/ainvr-relay /var/lib/ainvr-relay-auth /var/lib/ainvr-relay-web
   ```
   用 scp 把 `ainvr-relay-state.tgz` 传到新服务器。
4. 新服务器导入并重跑安装。安装会沿用原 CA，按新 IP 重签服务器证书（同时签域名），修正权限并启动服务：
   ```bash
   sudo tar xzpf ainvr-relay-state.tgz -C /
   sudo bash install-relay.sh --public-ip <新公网IP> --domain relay.gpling.com --tarball ... --checksums ...
   sudo rm -f ainvr-relay-state.tgz
   ```
5. DNSPod 把 `relay` 的 A 记录改为新公网 IP（TTL 600：约 10 分钟内设备陆续重连；frp 客户端每次重连都会重新解析）。旧服务器保持停止，不要两台同时运行。
6. 验证：`dig +short relay.gpling.com @119.29.29.29` 为新 IP；新服务器 `sudo relayctl list` 设备陆续变为在线、无身份冲突；页面 `https://relay.gpling.com:8181` 用原密码登录；当前工作设备需重新设一次（`sudo relayctl work <机器码>`），用页面命令登录成功。
7. 确认无误后清理旧服务器：删除 `/root/ainvr-relay-state.tgz` 与 `/etc/ainvr-relay` 备份，停用 `ainvr-relay*` 服务。

**注意**

- 运维入口命令 `ssh -J ubuntu@relay.gpling.com` 登录的是新服务器的 ubuntu 账号；首次连接 ssh 会提示新服务器主机密钥，核对后接受。
- 旧凭据按 IP 连接的设备（2026-10-08 改用域名之前打的离线包装出去的设备）不会跟随解析，需在设备页面把中转服务器改为 `relay.gpling.com`。目前已上线设备只有开发板，已改为域名。
- 如需在不改 IP 的情况下换机器，腾讯云普通云服务器可用弹性公网 IP 解绑后改绑新机器；轻量应用服务器的公网 IP 不能迁移，只能走上面的域名流程。
