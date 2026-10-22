#!/bin/bash
# Board guard v2: bounded pause of production AI (ainvr-ai + LocateAnything BPU backend) for a Qwen3-VL evaluation,
# restoring exactly the services active at test start (also on failure/timeout), then proving real recovery:
#  - LocateAnything read-only health (0 neural calls): ok/ready/76 programs/46 resident HBM, no CPU fallback;
#  - a fresh ainvr-ai archive_pipeline report after restore with healthy=true and a growing committed count.
# Recording/ingest are never touched.  usage: bash board_guard_eval_v2.sh MAX_SECONDS -- <command...>
set -u
MAX=$1; shift; [ "$1" = "--" ] && shift
UNITS="ainvr-ai ainvr-locateanything-official-bpu"
LOG=/mnt/ainvr-ssd/qwen3vl/guard-$(date +%Y%m%d-%H%M%S).json
LA_SHA=a4f584ab8e7f8742006bb4345e5ce7307846129534580715e543774401f92381
declare -A WAS
for u in $UNITS; do WAS[$u]=$(systemctl is-active $u); done
restore() {
  T0=$(date '+%Y-%m-%d %H:%M:%S')
  for u in $UNITS; do [ "${WAS[$u]}" = active ] && systemctl start $u; done
  for i in $(seq 1 60); do
    ok=1; for u in $UNITS; do [ "${WAS[$u]}" = active ] && [ "$(systemctl is-active $u)" != active ] && ok=0; done
    [ $ok = 1 ] && break; sleep 2
  done
  LA=skipped
  if [ "${WAS[ainvr-locateanything-official-bpu]}" = active ]; then
    for i in $(seq 1 30); do
      LA=$(cd /home/sunrise/ainvr && timeout 60 runuser -u sunrise -- python3 test/model_conversion/read_locateanything_prefill_three_groups_health_v216.py --contract-sha $LA_SHA 2>/dev/null | tail -1 | python3 -c "import sys,json;j=json.loads(sys.stdin.read());print('ok' if j['ok'] and j['ready'] and j['component_count']==76 and j['resident_models']==46 and not j['neural_cpu_fallback'] else 'bad')" 2>/dev/null)
      [ "$LA" = ok ] && break; sleep 5
    done
  fi
  AI=skipped
  if [ "${WAS[ainvr-ai]}" = active ]; then
    AI=no_fresh_report
    for i in $(seq 1 30); do
      R=$(journalctl -u ainvr-ai --since "$T0" --no-pager -o cat | grep archive_pipeline | tail -2 | python3 -c "
import sys,json,re
v=[]
for l in sys.stdin:
    m=json.loads(json.loads(l)['message'].split(' archive_pipeline ',1)[1]); v.append((m['healthy'],m['delivery']['committed']))
print('ok' if len(v)==2 and all(h for h,_ in v) and v[1][1]>v[0][1] else 'wait')" 2>/dev/null)
      [ "$R" = ok ] && AI=ok && break; sleep 10
    done
  fi
  st=""; for u in $UNITS ainvr-recorder ainvr-ingest; do st="$st\"$u\":\"$(systemctl is-active $u)\","; done
  echo "{\"restored_at\":\"$(date -Is)\",\"was\":{\"ainvr-ai\":\"${WAS[ainvr-ai]}\",\"ainvr-locateanything-official-bpu\":\"${WAS[ainvr-locateanything-official-bpu]}\"},\"now\":{${st%,}},\"locateanything_health\":\"$LA\",\"ai_archive_fresh\":\"$AI\",\"cmd_rc\":${RC:-null}}" > $LOG
  cat $LOG
}
trap restore EXIT
for u in $UNITS; do [ "${WAS[$u]}" = active ] && systemctl stop $u; done
echo "paused: $UNITS (was: ${WAS[*]}) recorder=$(systemctl is-active ainvr-recorder) ingest=$(systemctl is-active ainvr-ingest)"
timeout --kill-after=30 $MAX "$@"; RC=$?
echo "command rc=$RC"
