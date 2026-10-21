#!/bin/bash
# Host-side disk guard: stop all compiler processes in the qwen3vl container if C: < 8 GiB (vhdx growth) or D: < 10 GiB free.
export MSYS_NO_PATHCONV=1
LOG=/d/codex-task-staging/qwen3vl/work/disk-guard.log
stop_all() {
  docker exec ainvr-qwen3vl-20261020 bash -c 'for p in $(pgrep -f "run_o2|compile_o2|build_text_group|build_vision_group|hbdk"); do kill $p; done'
  echo "$(date -Is) $1 -> stopped compilers" >> $LOG
}
while true; do
  C=$(df -BG /c | awk 'NR==2{gsub("G","",$4); print $4}')
  D=$(df -BG /d | awk 'NR==2{gsub("G","",$4); print $4}')
  if [ "$C" -lt 8 ]; then stop_all "C free ${C}G"; exit 1; fi
  if [ "$D" -lt 10 ]; then stop_all "D free ${D}G"; exit 1; fi
  sleep 30
done
