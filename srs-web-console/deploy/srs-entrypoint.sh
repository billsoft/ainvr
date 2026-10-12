#!/bin/sh
# SRS startup: isolate volatile HLS output and validate before accepting streams.
set -eu

CONFIG_FILE="${SRS_CONFIG:-/usr/local/srs/conf/srs.conf}"
HLS_CONFIG="${SRS_HLS_CONFIG:-/usr/local/srs/conf/hls.conf}"
HTTP_ROOT=/run/srs-http
STATIC_ROOT=/usr/local/srs/objs/nginx/html

# Never silently fall back to the system disk when a release misses the mount.
if ! awk -v root="$HTTP_ROOT" '$2 == root && $3 == "tmpfs" { found=1 } END { exit !found }' /proc/mounts; then
    echo '[srs-io] startup rejected: /run/srs-http must be a tmpfs mount' >&2
    exit 1
fi
if ! awk '/^[[:space:]]*dir[[:space:]]/ { if ($2 != "/run/srs-http;") bad=1; found=1 }
    END { exit (bad || !found) }' "$CONFIG_FILE" ||
   ! awk '/^[[:space:]]*hls_path[[:space:]]/ { if ($2 != "/run/srs-http;") bad=1; found=1 }
    END { exit (bad || !found) }' "$HLS_CONFIG"; then
    echo '[srs-io] startup rejected: HLS and HTTP roots must use /run/srs-http' >&2
    exit 1
fi

# The original image assets stay visible; every app's HLS files live under tmpfs.
cp -R "$STATIC_ROOT/." "$HTTP_ROOT/"

# WebRTC 候选地址不在这里处理：默认自动（srs.conf 里 candidate *），页面指定的地址
# 由控制台写入配置文件。启动时不得再用环境变量覆盖，否则会冲掉页面保存的值。

# Catch incompatible directives before the live process starts.
./objs/srs -t -c "$CONFIG_FILE"
./objs/srs -t -c "$HLS_CONFIG"

# Independent OS process: synchronous HLS muxing/writes cannot block ingress.
# This supervisor lives in the same container lifecycle as the licensed SRS.
# The main process is still PID 1; its exit stops the entire container.
(
    while :; do
        (
            ./objs/srs -c "$HLS_CONFIG" && result=0 || result=$?
            echo "[srs-io] hls_worker_exit code=$result restart_in_seconds=2"
        ) 2>&1 | while IFS= read -r line; do
            # Persist even a transient write failure between capacity samples.
            # The tiny marker is outside the HLS filesystem that may be full.
            case "$line" in
                *FileWrite*|*'close file /run/srs-http/'*failed*|*'No space left on device'*)
                    : > /dev/shm/srs-hls-io-error ;;
            esac
            printf '%s\n' "$line"
        done
        sleep 2
    done
) &

# Capacity audit and HLS-only recovery. Never delete active media files.
# Compose bounds tmpfs capacity; SRS's hls_on_error isolates ENOSPC.
SRS_PID=$$
(
    previous=initial
    ticks=0
    full_seen=0
    while kill -0 "$SRS_PID" 2>/dev/null; do
        stats=$(df -Pk "$HTTP_ROOT" | awk 'NR == 2 { print $2, $3, $4, $5 }')
        set -- $stats
        if [ "$#" -eq 4 ]; then
            percent=${4%\%}
            state=normal
            if [ "$percent" -ge 80 ]; then state=pressure; fi
            if [ "$percent" -ge 95 ]; then full_seen=1; fi
            if [ -f /dev/shm/srs-hls-io-error ]; then full_seen=1; fi
            # ENOSPC can leave the muxer's in-memory segment state unusable.
            # Recreate ONLY HLS after space returns, with hysteresis. Never
            # kill ingress, delete live files, or restart the whole container.
            if [ "$full_seen" = 1 ] && [ "$percent" -lt 80 ]; then
                hls_pid=$(cat /run/srs-hls.pid 2>/dev/null || true)
                case "$hls_pid" in
                    ''|*[!0-9]*) ;;
                    *) if [ "$hls_pid" -gt 1 ] && grep -qx srs "/proc/$hls_pid/comm" 2>/dev/null; then
                           echo '[srs-io] hls_storage_recovered restarting_only_hls_worker'
                           kill -TERM "$hls_pid" 2>/dev/null || true
                       fi ;;
                esac
                full_seen=0
                rm -f /dev/shm/srs-hls-io-error
            fi
            if [ "$state" != "$previous" ] || [ "$ticks" -ge 60 ]; then
                echo "[srs-io] hls_capacity state=$state total_kib=$1 used_kib=$2 available_kib=$3 used_percent=$percent"
                previous=$state
                ticks=0
            fi
        fi
        sleep 5
        ticks=$((ticks + 1))
    done
) &

exec ./objs/srs -c "$CONFIG_FILE"
