import json
import sys
from pathlib import Path
import numpy as np

root=Path('/home/sunrise/ainvr')
result=root/'test/results/llm-service-development'
mode=sys.argv[1]
if mode=='tokens':
    actual=[json.loads(x) for x in (result/'encoded-dev.jsonl').read_text().splitlines()]
    reference=[json.loads(x) for x in Path('/mnt/ainvr-ssd/qwen3vl/run-v1/items-dev-v2.jsonl').read_text().splitlines()]
    assert len(actual)==len(reference)==157
    for a,b in zip(actual,reference):
        assert a['id']==b['id'] and a['input_ids']==b['input_ids'],a['id']
    print(json.dumps(dict(token_templates_equal=len(actual))))
elif mode=='logits':
    actual=[json.loads(x) for x in (result/'cpp-dev20.jsonl').read_text().splitlines()]
    reference=[json.loads(x) for x in (result/'python-dev20.jsonl').read_text().splitlines()]
    words=json.loads(Path('/mnt/ainvr-ssd/qwen3vl/head-o2-v3/tokens.json').read_text())['words']
    assert len(actual)==len(reference)==20
    worst=0
    for a,b in zip(actual,reference):
        assert a['id']==b['id']
        x=np.array(a['logits'],np.float32);y=np.array([b['logits'][w] for w in words],np.float32)
        worst=max(worst,float(np.max(np.abs(x-y))))
        assert np.array_equal(x.view(np.uint32),y.view(np.uint32)),(a['id'],worst)
    report=dict(items=20,logits_per_item=22,bitwise_equal=True,max_error=worst,
                cpp_median_ms=float(np.median([a['elapsed_ms'] for a in actual])))
    (result/'numerical-gate.json').write_text(json.dumps(report,indent=2))
    print(json.dumps(report))
else:raise ValueError(mode)
