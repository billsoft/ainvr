#!/bin/bash
# Board guard: bounded pause of production AI (ainvr-ai + LocateAnything BPU backend) for a full-BPU Qwen3-VL evaluation,
# restoring exactly the services that were active at test start (finally, also on failure/timeout). Recording/ingest untouched.
# usage: sudo bash board_guard_eval_v1.sh MAX_SECONDS -- <command...>
set -u
MAX=$1; shift; [ "$1" = "--" ] && shift
UNITS="ainvr-ai ainvr-locateanything-official-bpu"
LOG=/mnt/ainvr-ssd/qwen3vl/guard-$(date +%Y%m%d-%H%M%S).json
declare -A WAS
for u in $UNITS; do WAS[$u]=$(systemctl is-active $u); done
restore() {
  for u in $UNITS; do
    if [ "${WAS[$u]}" = active ]; then systemctl start $u; fi
  done
  for i in $(seq 1 60); do
    ok=1; for u in $UNITS; do [ "${WAS[$u]}" = active ] && [ "$(systemctl is-active $u)" != active ] && ok=0; done
    [ $ok = 1 ] && break; sleep 2
  done
  st=""; for u in $UNITS ainvr-recorder ainvr-ingest; do st="$st\"$u\":\"$(systemctl is-active $u)\","; done
  echo "{\"restored_at\":\"$(date -Is)\",\"was\":{\"ainvr-ai\":\"${WAS[ainvr-ai]}\",\"ainvr-locateanything-official-bpu\":\"${WAS[ainvr-locateanything-official-bpu]}\"},\"now\":{${st%,}},\"cmd_rc\":${RC:-null}}" > $LOG
  cat $LOG
}
trap restore EXIT
for u in $UNITS; do [ "${WAS[$u]}" = active ] && systemctl stop $u; done
echo "paused: $UNITS (was: ${WAS[*]}) recorder=$(systemctl is-active ainvr-recorder) ingest=$(systemctl is-active ainvr-ingest)"
timeout --kill-after=30 $MAX "$@"; RC=$?
echo "command rc=$RC"
