"""AINVR helper IPC parity with 128 original TorchScript tokenizer inputs."""
import argparse,json,subprocess,sys,hashlib
from pathlib import Path
import numpy as np
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--python',type=Path,required=True)
p.add_argument('--helper',type=Path,required=True)
p.add_argument('--assets',type=Path,required=True)
p.add_argument('--references',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();assert not a.output.exists()
cmd=[str(a.python),str(a.helper),'--assets',str(a.assets)]
manifest=json.loads((a.references/'manifest.json').read_text());items=manifest['samples'];assert len(items)==128
def run(payload):return subprocess.run(cmd,input=payload,capture_output=True,timeout=5)
for i in range(0,128,8):
    group=items[i:i+8];r=run(json.dumps({'phrases':[x['phrase'] for x in group]}).encode());assert r.returncode==0,r.stderr
    body=json.loads(r.stdout);assert body['neural_inference'] is False
    for item,tokens in zip(group,body['tokens']):
        assert np.array_equal(np.array(tokens,np.int32),np.load(a.references/item['file'])['tokens'][0])
cases=[b'{',b'{}',b'{"phrases":[]}',b'{"phrases":[""]}',b'{"phrases":[1]}',
       json.dumps({'phrases':['a']*9}).encode(),json.dumps({'phrases':['word '*500]}).encode(),b'x'*32769]
for payload in cases:
    r=run(payload);assert r.returncode==2 and not r.stdout
# Shell syntax stays literal text; no shell is involved in this invocation.
r=run(json.dumps({'phrases':['a person; echo dangerous','forklift & helmet']}).encode());assert r.returncode==0
report={'reference_token_sequences_exact':128,'invalid_requests_rejected':len(cases),
        'literal_shell_text_encoded':True,'helper_sha256':hashlib.sha256(a.helper.read_bytes()).hexdigest(),
        'neural_inference':False,'backend':'CPU string/BPE logic only','passed':True}
a.output.write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
