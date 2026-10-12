#!/bin/sh
set -eu
# Docker entrypoint runs this before nginx. Only explicitly configured upstream
# proxies may supply the original client address and external HTTPS scheme.
target=/etc/nginx/conf.d/00-trusted-proxy.conf
tmp="$target.tmp"
trap 'rm -f "$tmp"' EXIT
printf 'geo $realip_remote_addr $trusted_edge_proxy {\n default 0;\n' > "$tmp"
peers=$(printf '%s' "${TRUSTED_EDGE_PROXY_CIDRS:-}" | tr ',' ' ')
for peer in $peers; do
  if ! printf '%s\n' "$peer" | grep -Eq '^[0-9a-fA-F:.]+/[0-9]{1,3}$' || [ "${peer##*/}" -eq 0 ]; then
    echo 'Invalid TRUSTED_EDGE_PROXY_CIDRS; use explicit proxy IP/CIDR, never /0' >&2
    exit 1
  fi
  printf ' %s 1;\n' "$peer" >> "$tmp"
done
printf '}\n' >> "$tmp"
for peer in $peers; do printf 'set_real_ip_from %s;\n' "$peer" >> "$tmp"; done
cat >> "$tmp" <<'CONF'
real_ip_header X-Forwarded-For;
real_ip_recursive on;
map "$trusted_edge_proxy:$http_x_forwarded_proto" $console_forwarded_proto {
 default $scheme;
 "1:https" https;
 "1:http" http;
}
CONF
mv "$tmp" "$target"
# nginx validates address families/prefixes and fails closed on malformed input.
