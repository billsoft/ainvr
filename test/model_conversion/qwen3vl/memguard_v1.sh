#!/bin/bash
# Kill the parallel vision build if available RAM drops below 6 GiB (protects the critical-path text build).
while true; do
  P=$(ps -eo pid,args | grep "[b]uild_vision_group_v1.py --first 12" | awk '{print $1}')
  [ -z "$P" ] && exit 0
  A=$(free -g | awk 'NR==2{print $7}')
  if [ "$A" -lt 6 ]; then kill $P; sleep 2; mv /qwork/build/vis-12-18-o0-v3 /qwork/build/memguard-vis-12-18-o0-v3-$(date +%H%M); echo "killed at avail=$A" > /qwork/build/memguard.log; exit 0; fi
  sleep 10
done
