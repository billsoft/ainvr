#!/bin/bash
# Build all 27 MoonViT blocks with INT8 weights + qk16x16/sv16x16, three lanes, stage order.
cd /work/official-llm-v1
lane() { for s in "$@"; do [ -d /opt/locate-vision-recipe-probe-v296/block$s-qk16x16-sv16x16 ] && continue; setsid -w nice -n 10 /usr/bin/python3 -u probe_locateanything_vision_recipe_v296.py --stage $s --qk 16x16 --sv 16x16 > vision-recipe-v296-all27-b$s.log 2>&1; done; }
lane 0 3 6 9 12 15 18 21 24 & lane 1 4 7 10 13 16 19 22 25 & lane 2 8 11 14 17 20 23 26 & wait
echo ALL27_DONE > /work/official-llm-v1/vision-recipe-v296-all27.done
