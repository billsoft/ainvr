#!/bin/bash
# Host-side: stop all compiler processes in the qwen3vl container if C: free space drops below 8 GiB (vhdx growth guard).
export MSYS_NO_PATHCONV=1
while true; do
  FREE=$(df -BG /c | awk 'NR==2{gsub("G","",$4); print $4}')
  if [ "$FREE" -lt 8 ]; then
    docker exec ainvr-qwen3vl-20261020 bash -c 'for p in $(ps -eo pid,args | grep -E "[r]un_o2|[c]ompile_o2|[b]uild_|[h]bdk" | awk "{print \$1}"); do kill $p; done'
    echo "$(date -Is) C free ${FREE}G -> stopped compilers" >> /d/codex-task-staging/qwen3vl/work/c-guard.log; exit 1
  fi
  DF=$(df -BG /d | awk 'NR==2{gsub("G","",$4); print $4}'); if [ "$DF" -lt 10 ]; then docker exec ainvr-qwen3vl-20261020 bash -c 'for p in $(ps -eo pid,args | grep -E "[c]ompile_o2|[r]un_o2" | awk "{print $1}"); do kill $p; done'; echo "$(date -Is) D free ${DF}G -> stopped" >> /d/codex-task-staging/qwen3vl/work/c-guard.log; exit 1; fi
  sleep 30
done
