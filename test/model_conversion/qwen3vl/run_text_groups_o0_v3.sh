#!/bin/bash
# v3 (mask -96, quantized-domain softmax, all-BPU): after text captures: four 9-layer text groups (GPTQ W8 v1 codes, s1+s256, KV1024) at O0, then the decision head.
cd /qwork/scripts
until [ -f /qwork/cap/text-dev-v2/meta.json ]; do sleep 30; done
for g in 0 9 18 27; do
  setsid -w python3 -u build_text_group_v1.py --first $g --count 9 --device cpu --jobs 6 \
    --gptq /qwork/sim/gptq-v1/codes --calib /qwork/cap/text-calib-v2 --test /qwork/cap/text-dev-v2 --out /qwork/build/txt-$g-$((g+8))-o0-v3 > /qwork/build/txt-$g-$((g+8))-o0-v3.log 2>&1
done
setsid -w python3 -u build_head_v1.py --calib /qwork/cap/text-calib-v2 --test /qwork/cap/text-dev-v2 --out /qwork/build/head-o0-v3 > /qwork/build/head-o0-v3.log 2>&1
echo done > /qwork/build/txt-o0-v3.done
