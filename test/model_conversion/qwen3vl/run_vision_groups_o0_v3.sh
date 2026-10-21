#!/bin/bash
# v3 (quantized-domain split GELU, all-BPU): Build the four 6-block vision groups at O0 (rope as inputs, CPU calibration so the GPU stays free for GPTQ).
cd /qwork/scripts
for g in "0 6" "6 12" "12 18" "18 24"; do set -- $g
  setsid -w python3 -u build_vision_group_v1.py --first $1 --last $2 --rope-inputs --device cpu --jobs 3 \
    --calib /qwork/cap/vision-calib-v1 --test /qwork/cap/vision-dev-v1 --out /qwork/build/vis-$1-$2-o0-v3 > /qwork/build/vis-$1-$2-o0-v3.log 2>&1
done
echo done > /qwork/build/vis-o0-v3.done
