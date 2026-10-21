#!/bin/bash
# Compact status of all v3 builds + memory.
for d in /qwork/build/*-v3; do [ -f $d/status.json ] && python3 -c "
import json,sys;r=json.load(open(sys.argv[1]+'/status.json'));p=sys.argv[1].split('/')[-1]
x=[(e.get('profile'),[round(c['hidden']['rel_l2'],3) for c in e.get('compiler_vs_bf16',[])]) for e in r.get('profiles',[]) if 'compiler_vs_bf16' in e]
print(p.ljust(22),r['status'].ljust(14),r.get('hbm_bytes') or '',x if x else '',(r.get('error') or '')[-150:].replace(chr(10),' '))" $d; done
free -g | awk 'NR==2{print "mem used",$3"G avail",$7"G"} NR==3{print "swap used",$3"G"}'
