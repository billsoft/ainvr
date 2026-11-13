#!/bin/sh
# AINVR optional swap margin. Existing swap belongs to its current owner.
# stop deliberately leaves swap enabled; see docs/S100P-SWAP.md.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin
export PATH
umask 077

ZRAM_MIB="${AINVR_SWAP_ZRAM_MIB:-2048}"
FILE_MIB="${AINVR_SWAP_FILE_MIB:-4096}"
SSD="${AINVR_SWAP_SSD:-/mnt/ainvr-ssd}"
SWAPPINESS="${AINVR_SWAPPINESS:-10}"

log() { printf 'ainvr-swap: %s\n' "$*" >&2; }
die() { log "$*"; exit 1; }
active() { awk -v path="$1" 'NR > 1 && $1 == path { found=1 } END { exit !found }' /proc/swaps; }

number() {
  case "$2" in ''|*[!0-9]*|0[0-9]*) die "$1 must be a canonical nonnegative integer" ;; esac
  [ "${#2}" -le 6 ] && [ "$2" -le "$3" ] || die "$1 exceeds $3"
}

validate() {
  number AINVR_SWAP_ZRAM_MIB "$ZRAM_MIB" 65536
  number AINVR_SWAP_FILE_MIB "$FILE_MIB" 262144
  number AINVR_SWAPPINESS "$SWAPPINESS" 200
  case "$SSD" in /*) ;; *) die 'SSD path must be absolute' ;; esac
  # /proc/swaps escapes whitespace and backslashes. Reject ambiguous paths.
  case "$SSD" in *[[:space:]]*|*\\*) die 'SSD path cannot contain whitespace or backslashes' ;; esac
  [ "$SSD" != / ] || die 'SSD path cannot be the root filesystem'
  [ "$(id -u)" -eq 0 ] || die 'start requires root'
}

start_zram() {
  [ "$ZRAM_MIB" -gt 0 ] || return 0
  if awk 'NR > 1 && $1 ~ /^\/dev\/zram[0-9]+$/ { found=1 } END { exit !found }' /proc/swaps; then
    log 'preserving existing active zram (size, algorithm and priority unchanged)'
    return 0
  fi
  modprobe zram
  # zramctl only selects an uninitialized device. Never reset a device owned
  # by another service, even when it is not currently used as swap.
  zram=$(zramctl --find)
  case "$zram" in /dev/zram*) ;; *) die 'zramctl returned an unexpected device' ;; esac
  zram_sys="/sys/block/${zram##*/}"
  # Probe before initialization; never try an unsupported algorithm or reset.
  algorithms=$(cat "$zram_sys/comp_algorithm")
  if printf '%s\n' "$algorithms" | grep -qw zstd; then
    printf 'zstd\n' > "$zram_sys/comp_algorithm"
  fi
  printf '%sM\n' "$ZRAM_MIB" > "$zram_sys/disksize"
  mkswap "$zram" >/dev/null
  swapon -p 100 "$zram"
}

safe_file() {
  [ ! -L "$FILE" ] && [ -f "$FILE" ] || die "not a regular nonsymlink file: $FILE"
  [ "$(stat -c %u:%h "$FILE")" = 0:1 ] || die "swap file must be root-owned with one link: $FILE"
}

start_file() {
  [ "$FILE_MIB" -gt 0 ] || return 0
  if ! mountpoint -q "$SSD"; then
    log "SSD swap skipped: $SSD is not mounted"
    return 0
  fi
  [ "$(readlink -f "$SSD")" = "$SSD" ] || die 'SSD path must be canonical, without symlinks'
  # Reject bind mounts of the system filesystem as well as missing SSD mounts.
  [ "$(stat -c %d "$SSD")" != "$(stat -c %d /)" ] || die 'SSD is on the root filesystem'
  [ "$(stat -c %u "$SSD")" = 0 ] || die 'SSD mount must be root-owned'
  mode=$(stat -c %a "$SSD")
  [ "$((0$mode & 0022))" -eq 0 ] || die 'SSD mount cannot be group/world writable'
  case "$(findmnt -n -o FSTYPE -T "$SSD")" in
    ext4|xfs) ;;
    *) die 'SSD swap requires ext4 or xfs; other filesystems need explicit provisioning' ;;
  esac
  FILE="$SSD/swap/ainvr.swap"
  # Exact field matching handles tabs in /proc/swaps and literal dots in paths.
  if active "$FILE"; then
    log 'preserving existing active SSD swap (size and priority unchanged)'
    return 0
  fi
  [ ! -L "$SSD/swap" ] || die 'swap directory cannot be a symlink'
  mkdir -p "$SSD/swap"
  [ "$(stat -c %d "$SSD/swap")" = "$(stat -c %d "$SSD")" ] || die 'swap directory is not on the SSD filesystem'
  [ "$(stat -c %u "$SSD/swap")" = 0 ] || die 'swap directory must be root-owned'
  mode=$(stat -c %a "$SSD/swap")
  [ "$((0$mode & 0022))" -eq 0 ] || die 'swap directory cannot be group/world writable'
  want=$((FILE_MIB * 1024 * 1024))
  if [ -e "$FILE" ] || [ -L "$FILE" ]; then
    safe_file
    [ "$(stat -c %s "$FILE")" -eq "$want" ] || die 'existing swap size differs; offline resize requires explicit maintenance'
    type=$(blkid -p -s TYPE -o value "$FILE") || type=unknown
    if [ "$type" = swap ]; then
      chmod 600 "$FILE"
      swapon -p 10 "$FILE"
      return 0
    fi
    # Legacy script could die between fallocate and mkswap. Only recover an
    # entirely zero-filled file, never reformat unknown data or another FS.
    cmp -s -n "$want" "$FILE" /dev/zero || die 'existing file is not swap or all-zero; preserved for manual inspection'
    chmod 600 "$FILE"
    mkswap "$FILE" >/dev/null
    swapon -p 10 "$FILE"
    return 0
  fi

  # Keep an incomplete allocation away from the final name. SIGKILL/power loss
  # may leave a private .ainvr.swap.* file, but the next start can safely retry.
  pending=$(mktemp "$SSD/swap/.ainvr.swap.XXXXXXXX")
  trap 'if [ -n "$pending" ]; then rm -f -- "$pending"; fi' EXIT
  trap 'exit 1' HUP INT TERM
  fallocate -l "$want" "$pending"
  chmod 600 "$pending"
  mkswap "$pending" >/dev/null
  sync -f "$pending"
  # Same-directory rename publishes a complete file. Never overwrite a racing
  # creator; GNU mv -n returns success even if it skipped the source.
  mv -nT "$pending" "$FILE"
  [ ! -e "$pending" ] || die 'swap file appeared during creation; preserved'
  pending=''
  sync -f "$SSD/swap"
  swapon -p 10 "$FILE"
}

start() {
  validate
  # /run is root-controlled; a directory also excludes unsafe lock symlinks.
  [ ! -L /run/ainvr-swap ] || die 'runtime directory cannot be a symlink'
  mkdir -p /run/ainvr-swap
  [ "$(stat -c %u /run/ainvr-swap)" = 0 ] || die 'runtime directory must be root-owned'
  chmod 700 /run/ainvr-swap
  [ ! -L /run/ainvr-swap/lock ] || die 'runtime lock cannot be a symlink'
  if [ -e /run/ainvr-swap/lock ]; then
    [ -f /run/ainvr-swap/lock ] && [ "$(stat -c %u:%h /run/ainvr-swap/lock)" = 0:1 ] || die 'unsafe runtime lock'
  fi
  exec 9>>/run/ainvr-swap/lock
  flock -n 9 || die 'another start is running'
  start_file
  start_zram
  sysctl -q -w "vm.swappiness=$SWAPPINESS"
}

case "${1:-}" in
  start) start ;;
  stop) log 'swap left enabled; disable only during explicit offline maintenance' ;;
  status) cat /proc/swaps; printf 'swappiness %s\n' "$(cat /proc/sys/vm/swappiness)" ;;
  *) printf 'usage: %s start|stop|status\n' "$0" >&2; exit 2 ;;
esac
