#!/bin/bash
# Second lane: groups 27 then 18 (lane 1 skips them because the builder refuses existing output dirs).
cd /qwork/scripts
for g in 27 18; do
  setsid -w python3 -u build_text_group_v1.py --first $g --count 9 --device cpu --jobs 4 \
    --gptq /qwork/sim/gptq-v1/codes --calib /qwork/cap/text-calib-v2 --test /qwork/cap/text-dev-v2 --out /qwork/build/txt-$g-$((g+8))-o0-v3 > /qwork/build/txt-$g-$((g+8))-o0-v3.lane2.log 2>&1
done
echo done > /qwork/build/txt-lane2-v3.done
