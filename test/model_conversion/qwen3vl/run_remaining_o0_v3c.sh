#!/bin/bash
# Sequential (one heavy build at a time; two s256 compiler sims at once exhausted WSL RAM+swap).
# Text groups use QSILU=lut (official swish) to match group 9 (module sha 9215a4..); 1 compiler-reference fixture each.
cd /qwork/scripts
st() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['status'])" $1 2>/dev/null; }

for g in 9 18 0 27; do
  QSILU=lut QREFN=1 setsid -w python3 -u build_text_group_v1.py --first $g --count 9 --device cpu --jobs 7 --gptq /qwork/sim/gptq-v1/codes \
    --calib /qwork/cap/text-calib-v2 --test /qwork/cap/text-dev-v2 --out /qwork/build/txt-$g-$((g+8))-o0-v3 > /qwork/build/txt-$g-$((g+8))-o0-v3.log 2>&1
done
QSILU=lut setsid -w python3 -u build_head_v1.py --calib /qwork/cap/text-calib-v2 --test /qwork/cap/text-dev-v2 --out /qwork/build/head-o0-v3 > /qwork/build/head-o0-v3.log 2>&1
for g in "12 18" "18 24"; do set -- $g
  setsid -w python3 -u build_vision_group_v1.py --first $1 --last $2 --rope-inputs --device cpu --jobs 7 \
    --calib /qwork/cap/vision-calib-v1 --test /qwork/cap/vision-dev-v1 --out /qwork/build/vis-$1-$2-o0-v3 > /qwork/build/vis-$1-$2-o0-v3.log 2>&1
done
echo done > /qwork/build/remaining-o0-v3.done
