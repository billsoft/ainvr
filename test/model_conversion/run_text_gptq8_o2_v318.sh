#!/bin/bash
# Two lanes of same-BC opt2 group compiles (jobs=4 each); writes /work/official-llm-v1/v318.done at the end.
cd /work/official-llm-v1
lane() { for g in "$@"; do setsid -w /usr/bin/python3 -u compile_text_gptq8_groups_o2_v318.py --first $g --jobs 4 > v318-g$g.log 2>&1; done; }
lane 0 18 & lane 9 27 & wait
echo done > /work/official-llm-v1/v318.done
