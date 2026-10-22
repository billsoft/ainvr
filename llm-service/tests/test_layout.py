"""CPU-only reference checks; no model execution or production service changes."""
import argparse
import json
import subprocess
import sys
import tempfile
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'test/model_conversion/qwen3vl'))
import qwen3vl_host_v1 as reference


def main(probe):
    count = 0
    with tempfile.TemporaryDirectory() as tmp:
        inp, out = Path(tmp)/'in.json', Path(tmp)/'out.json'
        for length in [393, 466, 477, 512, 513, 768, 769, 1024]:
            ids = [1] + [151655]*392 + [2]*(length-393)
            inp.write_text(json.dumps(dict(input_ids=ids)))
            subprocess.run([probe, str(inp), str(out)], check=True)
            actual = json.loads(out.read_text())
            assert actual['positions'] == reference.rope_index(ids).T.tolist()
            plan = reference.prefill_plan(length, 256)
            assert [(x['start'],x['rows'],x['profile']) for x in actual['chunks']] == plan
            for c,(start,q,p) in zip(actual['chunks'],plan):
                expected=reference.chunk_call(np.zeros((length,2560),np.float32),
                    np.ones((length,128),np.float32),np.zeros((length,128),np.float32),[],[],start,q,p,1024,0)[3]
                assert np.array_equal(np.array(c['mask'],np.float32).reshape(p,1024),expected)
            count += 1
        for ids in [[], [1]*466, [151655]*391+[2], [151655]*393, [1]+[151655]*392+[2]*632]:
            inp.write_text(json.dumps(dict(input_ids=ids)))
            assert subprocess.run([probe,str(inp),str(out)],capture_output=True).returncode != 0
            count += 1
    print(json.dumps(dict(passed=count, scope='position, mask, prefill, invalid image/context')))


if __name__=='__main__':
    main(sys.argv[1])
