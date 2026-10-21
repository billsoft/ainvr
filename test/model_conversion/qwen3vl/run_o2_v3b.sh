#!/bin/bash
# Same-BC O2 for every v3 O0 package, one at a time; compiler temp files on D: (TMPDIR) instead of the C:-backed vhdx.
cd /qwork/scripts
export TMPDIR=/qwork/tmp; mkdir -p $TMPDIR
st() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['status'])" $1 2>/dev/null; }
until [ "$(st /qwork/build/vis-0-6-o2-v3/status.json)" = done -o "$(st /qwork/build/vis-0-6-o2-v3/status.json)" = failed ]; do sleep 30; done
for p in vis-6-12 vis-12-18 vis-18-24 txt-0-8 txt-9-17 txt-18-26 txt-27-35 head; do
  setsid -w python3 -u compile_o2_same_bc_v1.py /qwork/build/$p-o0-v3 /qwork/build/$p-o2-v3 7 > /qwork/build/$p-o2-v3.log 2>&1
done
echo done > /qwork/build/o2-v3.done
