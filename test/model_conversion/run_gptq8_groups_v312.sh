#!/bin/bash
# Build the four GPTQ INT8 decoder groups (O0, both profiles) in two lanes; CPU compile phases serialize on the builder lock.
cd /work/official-llm-v1
lane() { for g in "$@"; do setsid -w /usr/bin/python3 -u build_locateanything_official_qwen_group_gptq8_v312.py --first $g --layers 9 --out /opt/locate-official-qwen-group-gptq8-$g-$((g+8))-v312 > v312-g$g.log 2>&1; done; }
lane 0 18 & lane 9 27 & wait
echo done > /work/official-llm-v1/v312.done
