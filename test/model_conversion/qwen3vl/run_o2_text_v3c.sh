#!/bin/bash
# Text-group same-BC O2 (retry after D: filled up: ConstantWriter I/O error), one at a time, TMPDIR on D:.
cd /qwork/scripts; export TMPDIR=/qwork/tmp; mkdir -p $TMPDIR
for p in txt-0-8 txt-9-17 txt-18-26 txt-27-35; do
  setsid -w python3 -u compile_o2_same_bc_v1.py /qwork/build/$p-o0-v3 /qwork/build/$p-o2-v3 7 > /qwork/build/$p-o2-v3.log 2>&1
done
echo done > /qwork/build/o2-text-v3.done
