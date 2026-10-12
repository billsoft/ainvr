"""AINVR unseen text references from the original MobileCLIP2 TorchScript.

Development CPU oracle only, never a production neural inference path.
The fixed set is generated before candidate board validation, not selected from
its successes. Exact overlap checks cover calibration and both prior text sets.
"""
import argparse
import hashlib
import json
import sys
from pathlib import Path
import numpy as np
import torch

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--root',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args()
assert not a.output.exists()
source=a.root/'mobileclip2_b.ts'
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
assert sha(source)=='35d7f213e4d75f38514e4656ad3cb91158bd33e3805d8ac349f23b186f66982f'
nouns=['forklift','firefighter','electric scooter','hard hat','safety vest',
       'delivery van','shipping container','pallet','cardboard carton','metal gate',
       'security checkpoint','person carrying a backpack','person riding a bicycle',
       'construction worker','smoke','flame','spilled water','broken window',
       'open door','parked motorcycle','loose cable','helmet','wheelchair',
       'shopping trolley','ladder','traffic cone','solar panel','drone','stroller',
       'toolbox','industrial robot','conveyor belt']
templates=['an image showing {}','a surveillance view of {}','{} at night','a close view of {}']
phrases=[t.format(n) for t in templates for n in nouns]
assert len(set(phrases))==128
observed=set()
for directory in ['text-calibration-512','text-validation-128-v1','text-heldout-128-v2']:
    m=json.loads((a.root/directory/'manifest.json').read_text())
    observed.update(x['phrase'] for x in m.get('items',m.get('samples',[])))
assert not set(phrases)&observed
sys.path.insert(0,str(a.root/'clip-tokenizer'))
from simple_tokenizer import SimpleTokenizer
tokenizer=SimpleTokenizer(str(a.root/'clip-tokenizer/bpe_simple_vocab_16e6.txt.gz'))
torch.set_num_threads(2)
encoder=torch.jit.load(str(source),map_location='cpu').eval().float()
a.output.mkdir()
rows=[]
for i,phrase in enumerate(phrases):
    ids=[tokenizer.encoder['<|startoftext|>']]+tokenizer.encode(phrase)+[tokenizer.encoder['<|endoftext|>']]
    assert len(ids)<=77
    tokens=np.zeros((1,77),np.int32);tokens[0,:len(ids)]=ids
    with torch.no_grad():reference=encoder(torch.from_numpy(tokens.astype(np.int64))).numpy()
    assert reference.shape==(1,512) and np.isfinite(reference).all()
    filename=f'{i:03}.npz'
    np.savez_compressed(a.output/filename,tokens=tokens,reference=reference)
    rows.append({'phrase':phrase,'file':filename,'sha256':sha(a.output/filename)})
r={'scope':'Unseen original FP32 text-encoder references, including non-COCO free phrases',
   'heldout':True,'calibration_overlap':0,'prior_validation_overlap':0,
   'source_sha256':sha(source),'samples':rows,'production_approved':False}
(a.output/'manifest.json').write_text(json.dumps(r,indent=2))
print(json.dumps({k:v for k,v in r.items() if k!='samples'},indent=2))
