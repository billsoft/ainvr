#!/usr/bin/env bash
# 远程协助中转服务器安装（Ubuntu，root 运行，可重复执行）。
#   frps 只做 STCP 中转：设备主动连本服务器，服务器不对公网开放任何设备的登录端口。
#   设备免开通：装了统一接入凭据（relayctl fleet）的设备按机器码自动出现；运维在页面选"当前工作设备"，
#   经云服务器本机 127.0.0.1:6000（ainvr-relay-work）远程登录。
#   强制 TLS，证书由本机自建 CA 签发（CA 私钥只给 root）；防火墙只放行中转端口。
# 管理页面：https://<公网IP>:8181（独立低权限账号运行，经 sudo relayctl 执行操作）。
# 用法：
#   sudo ./install-relay.sh --public-ip 43.163.66.62 --domain relay.gpling.com \
#        --tarball frp_0.71.0_linux_amd64.tar.gz --checksums frp_sha256_checksums.txt [--port 33888] [--web-port 8181]
# --domain（推荐）：设备与运维按域名连接，证书同时签域名和 IP；更换服务器只需迁移状态目录并改解析，
# 已出货设备无需改动。不给域名时按 IP 连接（换服务器 IP 会导致所有设备连不上）。
set -euo pipefail

PORT=33888 WEB_PORT=8181 PUBLIC_IP="" DOMAIN="" TARBALL="" SUMS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT=$2; shift 2 ;;
    --web-port) WEB_PORT=$2; shift 2 ;;
    --public-ip) PUBLIC_IP=$2; shift 2 ;;
    --domain) DOMAIN=$2; shift 2 ;;
    --tarball) TARBALL=$2; shift 2 ;;
    --checksums) SUMS=$2; shift 2 ;;
    *) echo "未知参数 $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "需要 root 运行" >&2; exit 1; }
[ -n "$PUBLIC_IP" ] && [ -f "$TARBALL" ] && [ -f "$SUMS" ] || { echo "缺少 --public-ip / --tarball / --checksums" >&2; exit 2; }
if [ -n "$DOMAIN" ] && ! [[ "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]]; then
  echo "域名格式不对: $DOMAIN" >&2; exit 2
fi
# 设备、运维入口与证书校验使用的服务器名：有域名用域名，否则用 IP
SERVER="${DOMAIN:-$PUBLIC_IP}"
CONF=/etc/ainvr-relay
SRC=$(cd "$(dirname "$0")" && pwd)

# 不与本机已有业务抢端口
if ss -ltnH "( sport = :$PORT )" | grep -q . && ! systemctl is-active --quiet ainvr-relay; then
  echo "端口 $PORT 已被其他程序占用" >&2; exit 1
fi
if ss -ltnH "( sport = :$WEB_PORT )" | grep -q . && ! systemctl is-active --quiet ainvr-relay-web; then
  echo "管理页面端口 $WEB_PORT 已被其他程序占用" >&2; exit 1
fi

# 官方发布包按官方校验和核对
name=$(basename "$TARBALL")
expected=$(awk -v n="$name" '$2==n {print $1}' "$SUMS")
[ -n "$expected" ] && echo "$expected  $TARBALL" | sha256sum -c --status - || { echo "frp 安装包校验失败" >&2; exit 1; }
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
tar xzf "$TARBALL" -C "$tmp"
# 同目录临时文件 + mv 原子替换：中途失败不会留下残缺程序，运行中的进程继续用旧文件
install -d -m 0755 /opt/ainvr-relay
for b in frps frpc; do  # frpc 用作云本机"当前工作设备"入口
  install -m 0755 "$tmp"/*/$b /opt/ainvr-relay/.$b.new
  mv -f /opt/ainvr-relay/.$b.new /opt/ainvr-relay/$b
done

getent group ainvr-relay >/dev/null || groupadd --system ainvr-relay
id -u ainvr-relay >/dev/null 2>&1 || useradd --system --gid ainvr-relay --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin ainvr-relay
install -d -o root -g ainvr-relay -m 0750 "$CONF" "$CONF/tls"
install -d -o root -g root -m 0700 "$CONF/ca"

[ -s "$CONF/token" ] || (umask 077; openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 48 > "$CONF/token")
[ -s "$CONF/dashboard.pass" ] || (umask 077; openssl rand -hex 16 > "$CONF/dashboard.pass")

# 自建 CA：密钥只生成一次；设备凭据里的 ca_cert 就是这份公钥证书。
# 证书带标准扩展（CA:TRUE、keyCertSign）——严格校验器（新版 Python、部分浏览器）要求；
# 旧版缺扩展时用同一密钥、同一名称重签，已下发设备的旧 CA 证书仍可校验（同钥同名）。
CA_SUBJ="/CN=AINVR Remote Assist CA"
CA_EXT=(-addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -addext "subjectKeyIdentifier=hash")
if [ ! -s "$CONF/ca/ca.key" ]; then
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -subj "$CA_SUBJ" "${CA_EXT[@]}" \
    -keyout "$CONF/ca/ca.key" -out "$CONF/tls/ca.crt" 2>/dev/null
elif ! openssl x509 -in "$CONF/tls/ca.crt" -noout -ext keyUsage 2>/dev/null | grep -q "Certificate Sign"; then
  openssl req -x509 -new -key "$CONF/ca/ca.key" -days 3650 -subj "$CA_SUBJ" "${CA_EXT[@]}" -out "$tmp/ca.crt" 2>/dev/null
  mv -f "$tmp/ca.crt" "$CONF/tls/ca.crt"
fi
# 服务端证书：地址/域名变化或缺少标准扩展时重签（沿用已有私钥）。同时签 IP 与域名：
# 按 IP 下发的旧凭据继续有效，按域名的新凭据也能校验。
SAN="IP:$PUBLIC_IP${DOMAIN:+,DNS:$DOMAIN}"
if [ ! -s "$CONF/tls/server.crt" ] \
   || ! openssl x509 -in "$CONF/tls/server.crt" -noout -ext subjectAltName 2>/dev/null | grep -q "IP Address:$PUBLIC_IP" \
   || { [ -n "$DOMAIN" ] && ! openssl x509 -in "$CONF/tls/server.crt" -noout -ext subjectAltName 2>/dev/null | grep -q "DNS:$DOMAIN"; } \
   || ! openssl x509 -in "$CONF/tls/server.crt" -noout -ext authorityKeyIdentifier 2>/dev/null | grep -q .; then
  if [ -s "$CONF/tls/server.key" ]; then
    openssl req -new -key "$CONF/tls/server.key" -subj "/CN=$SERVER" -out "$tmp/server.csr" 2>/dev/null
  else
    openssl req -newkey rsa:2048 -nodes -subj "/CN=$SERVER" -keyout "$CONF/tls/server.key" -out "$tmp/server.csr" 2>/dev/null
  fi
  printf '%s\n' "basicConstraints=CA:FALSE" "subjectAltName=$SAN" "extendedKeyUsage=serverAuth" \
    "keyUsage=critical,digitalSignature,keyEncipherment" "subjectKeyIdentifier=hash" "authorityKeyIdentifier=keyid,issuer" > "$tmp/ext.cnf"
  openssl x509 -req -in "$tmp/server.csr" -CA "$CONF/tls/ca.crt" -CAkey "$CONF/ca/ca.key" \
    -CAserial "$CONF/ca/ca.srl" -CAcreateserial -days 1825 -extfile "$tmp/ext.cnf" -out "$tmp/server.crt" 2>/dev/null
  mv -f "$tmp/server.crt" "$CONF/tls/server.crt"
fi
openssl verify -x509_strict -CAfile "$CONF/tls/ca.crt" "$CONF/tls/server.crt" >/dev/null || { echo "证书校验失败" >&2; exit 1; }
chown root:ainvr-relay "$CONF/tls/server.key" "$CONF/tls/server.crt" "$CONF/tls/ca.crt"
chmod 0640 "$CONF/tls/server.key"
chmod 0644 "$CONF/tls/server.crt" "$CONF/tls/ca.crt"

# 鉴权插件与管理命令（原子替换）
for f in relay_auth.py relayctl.py relay_web.py relay_web.html relay_web.js relay_web.css; do
  install -m 0755 "$SRC/$f" "/opt/ainvr-relay/.$f.new"
  mv -f "/opt/ainvr-relay/.$f.new" "/opt/ainvr-relay/$f"
done
ln -sf /opt/ainvr-relay/relayctl.py /usr/local/sbin/relayctl
# 设备身份表（鉴权插件唯一写入；缺失即拒绝全部设备，所以只在首次安装/升级时创建）与 auth.json v2。
# 从按设备开通的旧版升级：沿用旧设备令牌哈希作为已记住的身份、保留暂停标志与备注，设备无感知。
install -d -o ainvr-relay -g ainvr-relay -m 0700 /var/lib/ainvr-relay-auth
python3 - "$CONF" /var/lib/ainvr-relay-auth/identities.json <<'PY'
import json, os, pwd, sys, time
sys.path.insert(0, "/opt/ainvr-relay")
from relay_auth import empty_state, normalize_code, write_state
import grp
conf, ids_path = sys.argv[1], sys.argv[2]
def load(name, default):
    try:
        return json.load(open(os.path.join(conf, name), encoding="utf-8"))
    except FileNotFoundError:
        return default
auth = load("auth.json", empty_state())
if not os.path.exists(ids_path):
    seed = {}
    for dev, e in (auth.get("devices") or {}).items():
        code = normalize_code(dev)
        if code and e.get("token_sha256"):
            seed[code] = {"token_sha256": e["token_sha256"], "first_seen": int(time.time())}
    tmp = ids_path + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
        json.dump({"version": 1, "devices": seed}, f, indent=2)
    u = pwd.getpwnam("ainvr-relay")
    os.chown(tmp, u.pw_uid, u.pw_gid)
    os.replace(tmp, ids_path)
    print(f"设备身份表已创建（沿用 {len(seed)} 台旧设备身份）")
if auth.get("version") != 2:
    new = {"version": 2, "global_suspended": bool(auth.get("global_suspended")), "devices": {}}
    if auth.get("global_reason"):
        new["global_reason"] = auth["global_reason"]
    for dev, e in (auth.get("devices") or {}).items():
        code = normalize_code(dev)
        if code and e.get("suspended"):
            new["devices"][code] = {"suspended": True, "reason": e.get("reason", "")}
    write_state(__import__("pathlib").Path(conf, "auth.json"), new, grp.getgrnam("ainvr-relay").gr_gid)
    labels = {normalize_code(k): v["label"] for k, v in load("devices.json", {}).items()
              if normalize_code(k) and v.get("label")}
    if labels and not os.path.exists(os.path.join(conf, "labels.json")):
        with open(os.open(os.path.join(conf, "labels.json"), os.O_WRONLY | os.O_CREAT, 0o600), "w", encoding="utf-8") as f:
            json.dump(labels, f, ensure_ascii=False, indent=2)
    print("鉴权状态已升级为免开通格式（旧 devices.json / operators.json 不再使用，可人工归档）")
PY
# 统一接入凭据（只在首次生成密钥；地址变化时更新）
AINVR_RELAY_CONF="$CONF" python3 /opt/ainvr-relay/relayctl.py --actor install --json fleet --server "$SERVER" --port "$PORT" >/dev/null

token=$(cat "$CONF/token"); dpass=$(cat "$CONF/dashboard.pass")
(umask 027; cat > "$CONF/frps.toml" <<EOF
bindAddr = "0.0.0.0"
bindPort = $PORT
auth.method = "token"
auth.token = "$token"
transport.tls.force = true
transport.tls.certFile = "$CONF/tls/server.crt"
transport.tls.keyFile = "$CONF/tls/server.key"
# 只做 STCP 中转：不允许客户端在服务器上开公网端口（该端口防火墙也不放行）
allowPorts = [{ single = 65535 }]
webServer.addr = "127.0.0.1"
webServer.port = 7500
webServer.user = "admin"
webServer.password = "$dpass"
log.to = "console"
log.level = "info"
# 拒绝原因（AINVR_SUSPENDED 等）原样回传设备，设备页面据此显示"云端已暂停"
detailedErrorsToClient = true
# 服务端心跳超时：frps 只在心跳被接受时刷新时间戳，被拒绝（暂停/停用）或不发心跳的客户端——
# 包括无视拒绝的改造客户端——40 秒内由服务端主动断开。设备与访问端配置均为 10 秒心跳。
transport.heartbeatTimeout = 40

# 按设备鉴权与暂停闸门：插件不可达时 frps 拒绝请求（fail-closed）
[[httpPlugins]]
name = "ainvr-auth"
addr = "127.0.0.1:7600"
path = "/handler"
ops = ["Login", "NewProxy", "Ping", "NewWorkConn"]
EOF
)
chown root:ainvr-relay "$CONF/frps.toml"
/opt/ainvr-relay/frps verify -c "$CONF/frps.toml" >/dev/null

cat > /etc/systemd/system/ainvr-relay-auth.service <<EOF
[Unit]
Description=AINVR Remote Assist Relay Auth Plugin
After=network.target
StartLimitIntervalSec=0
[Service]
Type=simple
User=ainvr-relay
Group=ainvr-relay
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 /opt/ainvr-relay/relay_auth.py
Restart=always
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/ainvr-relay-auth
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
CapabilityBoundingSet=
[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/ainvr-relay.service <<EOF
[Unit]
Description=AINVR Remote Assist Relay
After=network-online.target ainvr-relay-auth.service
Wants=network-online.target ainvr-relay-auth.service
StartLimitIntervalSec=0
[Service]
Type=simple
User=ainvr-relay
Group=ainvr-relay
ExecStart=/opt/ainvr-relay/frps -c $CONF/frps.toml
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
CapabilityBoundingSet=
LimitNOFILE=65536
[Install]
WantedBy=multi-user.target
EOF
# 当前工作设备入口：云本机 127.0.0.1:6000 → 选定设备（relayctl work 写配置并重启；未选定时不运行）
cat > /etc/systemd/system/ainvr-relay-work.service <<EOF
[Unit]
Description=AINVR Remote Assist Current Work Device Entry
After=network-online.target ainvr-relay.service
ConditionPathExists=$CONF/work.toml
StartLimitIntervalSec=0
[Service]
Type=simple
ExecStart=/opt/ainvr-relay/frpc -c $CONF/work.toml
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ainvr-relay-auth ainvr-relay ainvr-relay-work >/dev/null 2>&1
systemctl restart ainvr-relay-auth
systemctl restart ainvr-relay

# ---- 管理页面 ----
getent group ainvr-relay-web >/dev/null || groupadd --system ainvr-relay-web
id -u ainvr-relay-web >/dev/null 2>&1 || useradd --system --gid ainvr-relay-web --no-create-home \
  --home-dir /nonexistent --shell /usr/sbin/nologin ainvr-relay-web
WEB=/var/lib/ainvr-relay-web
install -d -o ainvr-relay-web -g ainvr-relay-web -m 0700 "$WEB" "$WEB/tls"
install -o ainvr-relay-web -g ainvr-relay-web -m 0644 "$CONF/tls/server.crt" "$WEB/tls/server.crt"
install -o ainvr-relay-web -g ainvr-relay-web -m 0600 "$CONF/tls/server.key" "$WEB/tls/server.key"
printf 'AINVR_RELAY_PUBLIC_IP=%s\nAINVR_RELAY_SERVER=%s\nAINVR_RELAY_PORT=%s\nAINVR_RELAY_WEB_PORT=%s\n' "$PUBLIC_IP" "$SERVER" "$PORT" "$WEB_PORT" > "$CONF/web.env"
chmod 0644 "$CONF/web.env"
# 只允许管理页面账号以 root 执行 relayctl（参数由 relayctl 自身校验）
SUDOERS=/etc/sudoers.d/ainvr-relay-web
printf 'ainvr-relay-web ALL=(root) NOPASSWD: /usr/local/sbin/relayctl\n' > "$SUDOERS.tmp"
chmod 0440 "$SUDOERS.tmp"
visudo -cf "$SUDOERS.tmp" >/dev/null && mv -f "$SUDOERS.tmp" "$SUDOERS" || { rm -f "$SUDOERS.tmp"; echo "sudoers 校验失败" >&2; exit 1; }
# 尚未设置管理员密码时发放初始化码（已设置则不动）
if [ ! -s "$WEB/admin.json" ] && [ ! -s "$WEB/setup.code" ]; then
  AINVR_RELAY_CONF="$CONF" python3 /opt/ainvr-relay/relayctl.py --actor install web-reset >/dev/null
fi
cat > /etc/systemd/system/ainvr-relay-web.service <<EOF
[Unit]
Description=AINVR Remote Assist Relay Admin Web
After=network-online.target ainvr-relay.service
Wants=network-online.target
StartLimitIntervalSec=0
[Service]
Type=simple
User=ainvr-relay-web
Group=ainvr-relay-web
EnvironmentFile=$CONF/web.env
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 /opt/ainvr-relay/relay_web.py
Restart=always
RestartSec=3
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable ainvr-relay-web >/dev/null 2>&1
systemctl restart ainvr-relay-web

if ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow "$PORT/tcp" comment 'ainvr remote assist relay' >/dev/null
  ufw allow "$WEB_PORT/tcp" comment 'ainvr remote assist admin web' >/dev/null
fi
sleep 2
systemctl is-active ainvr-relay-auth ainvr-relay ainvr-relay-web
# 以下只是提示；用 if 而不是 &&，避免条件不成立时把成功的安装报成失败（退出码 1）
if ss -ltnH "( sport = :$PORT )" | grep -q .; then echo "中转服务已监听 $PORT（云平台安全组也需放行 TCP $PORT）"; fi
if ss -ltnH "( sport = :$WEB_PORT )" | grep -q .; then echo "管理页面：https://$SERVER:$WEB_PORT（云平台安全组也需放行 TCP $WEB_PORT）"; fi
if [ -s "$WEB/setup.code" ]; then echo "首次打开需初始化码：sudo cat $WEB/setup.code"; fi
echo "统一接入凭据：sudo relayctl fleet（放到打包机 deploy-package/vendor/remote-assist/）"
exit 0
