#!/bin/bash
# Pinned standalone MongoDB 7 OP_MSG ping. No credentials, JS runtime or data reads.
# Strict response validation fails closed on errors or unexpected protocol changes.
set -euo pipefail
port=${1:-27017}
[[ "$port" =~ ^[0-9]{1,5}$ ]] && ((port>0 && port<65536))
exec 3<>/dev/tcp/127.0.0.1/$port
printf '%b' '\x33\x00\x00\x00\x2a\x00\x00\x00\x00\x00\x00\x00\xdd\x07\x00\x00\x00\x00\x00\x00\x00\x1e\x00\x00\x00\x10\x70\x69\x6e\x67\x00\x01\x00\x00\x00\x02\x24\x64\x62\x00\x06\x00\x00\x00\x61\x64\x6d\x69\x6e\x00\x00' >&3
reply=$(dd bs=1 count=38 status=none <&3 | od -An -tx1)
reply=${reply//[[:space:]]/}
[[ "$reply" =~ ^26000000[0-9a-f]{8}2a000000dd070000000000000011000000016f6b00000000000000f03f00$ ]]
