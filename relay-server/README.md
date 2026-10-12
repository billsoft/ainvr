# 远程协助中转服务器

客户设备**主动连接**本服务器，经 frp STCP 对接；服务器不对公网开放任何设备的远程登录端口。设备免开通：装了统一接入凭据的设备开启远程协助后按授权机器码自动出现；运维在管理页面选一台设为「当前工作设备」，经云服务器本机固定入口远程登录。设备端见 [docs/remote-assist-client.md](../docs/remote-assist-client.md)；部署清单、远程维护、暂停与恢复、身份冲突、排障见运维手册 [docs/remote-assist-ops.md](../docs/remote-assist-ops.md)。

```
客户设备 frpc ──TLS──▶ 中转 frps :33888 ◀── 当前工作设备入口 frpc（云本机 127.0.0.1:6000）◀── ssh -J
                              │
                     鉴权插件 127.0.0.1:7600
         （机器码首次记住设备令牌、冒用拒绝、隧道与访问者范围约束、暂停闸门）
```

## 组成

| 文件 | 作用 |
|---|---|
| `install-relay.sh` | 安装/升级：frps 与 frpc、TLS（自建 CA）、鉴权插件、当前工作设备入口、管理页面、`relayctl`、systemd、本机防火墙；从按设备开通的旧版升级时迁移身份与暂停状态。可重复执行，成功返回 0 |
| `relay_auth.py` | frps 服务端插件：设备按机器码首次记住令牌（`/var/lib/ainvr-relay-auth/identities.json`，插件唯一写入），令牌不符即「身份冲突」；只允许注册本机 `<机器码>-ssh` STCP 隧道且不得放宽访问者范围；工作入口只认云本机令牌且来源须为本机地址；单台/全部暂停；状态读不到时全部拒绝，插件不可达时 frps 拒绝 |
| `relay_web.py`、`relay_web.html/.js/.css` | 管理页面（HTTPS 8181）：设备列表（机器码、在线、身份冲突）、设为当前工作设备并复制登录命令、暂停/恢复/强制断开、全部暂停、重置设备身份、备注、统一接入凭据下载、在线连接、操作记录。以 `ainvr-relay-web` 账号运行，只能经 sudo 白名单执行 relayctl |
| `relayctl.py` | 管理命令（安装为 `/usr/local/sbin/relayctl`，仅 root），操作写审计日志 |

## 安装 / 升级（Ubuntu，root）

```bash
V=0.71.0
curl -fsSLO https://github.com/fatedier/frp/releases/download/v$V/frp_${V}_linux_amd64.tar.gz
curl -fsSLO https://github.com/fatedier/frp/releases/download/v$V/frp_sha256_checksums.txt
sudo bash install-relay.sh --public-ip <公网IP> --domain relay.gpling.com --tarball frp_${V}_linux_amd64.tar.gz --checksums frp_sha256_checksums.txt
```

`--domain`：设备与运维按域名连接，证书同时签域名和 IP。更换服务器时迁移状态目录后改解析即可，步骤见运维手册第 14 节（不要在新服务器从零安装，否则已出货设备全部失效）。

云平台安全组需另行放行 TCP 33888 与 8181。升级前先备份 `/etc/ainvr-relay`。

## 常用命令（机器码可带横杠）

```bash
sudo relayctl list                                   # 设备、云端状态、在线、当前工作设备（★）
sudo relayctl work <机器码>                           # 设为当前工作设备，输出登录命令
sudo relayctl work --clear                           # 结束工作，关闭入口
sudo relayctl suspend <机器码>|--all [--reason 原因] [--hard]
sudo relayctl resume <机器码>|--all
sudo relayctl reset <机器码>                          # 重置设备身份（重装系统导致身份冲突时）
sudo relayctl label <机器码> <备注>
sudo relayctl fleet [--server <公网IP>]              # 导出统一接入凭据到 /root/ainvr-relay-fleet/（随安装包下发）
sudo relayctl audit [--limit 50]                     # 操作记录
sudo relayctl web-reset                              # 重置管理页面密码（生成新初始化码）
```

登录当前工作设备（公司电脑，先输云服务器密码再输设备密码）：

```bash
ssh -J ubuntu@relay.gpling.com -p 6000 -o HostKeyAlias=ainvr-<机器码> ainvr@127.0.0.1
```

- 单台暂停与全部暂停相互独立：`resume --all` 不会解除某台设备原有的暂停。
- 单台 `suspend --hard` 只断开该设备公网 IP 的连接（`ss -K`），不重启中转；`--all --hard` 重启中转。
- 设备与工作入口的 frp `user` 均为机器码，frp 拒绝不登录的旧访问路径；服务端心跳超时 40 秒，心跳被拒的客户端由服务端断开。

## 已知限制

- 统一接入凭据随安装包分发，按可能泄露对待：它只让设备能连上；冒用已出现设备的机器码会因令牌不符被拒，但可以抢先占用尚未连上过的机器码（真设备显示身份冲突，确认后 `reset`）。
- 同一时间只有一台当前工作设备；入口的访问控制是云服务器 SSH 账号本身。
- 运维登录设备仍以设备本机 sshd 鉴权为准；正式交付前设备应改为仅密钥登录。
