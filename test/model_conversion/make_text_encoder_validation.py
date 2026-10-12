"""AINVR independent MobileCLIP2 text oracle; offline development host only."""
import argparse, hashlib, json, sys
from pathlib import Path
import numpy as np
import torch
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--root',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--heldout',action='store_true')
a=p.parse_args(); a.output.mkdir(exist_ok=False); torch.set_num_threads(2)
sys.path.insert(0,str(a.root/'clip-tokenizer'))
from simple_tokenizer import SimpleTokenizer
tokenizer=SimpleTokenizer(str(a.root/'clip-tokenizer/bpe_simple_vocab_16e6.txt.gz'))
source=a.root/'mobileclip2_b.ts'
assert hashlib.sha256(source.read_bytes()).hexdigest()=='35d7f213e4d75f38514e4656ad3cb91158bd33e3805d8ac349f23b186f66982f'
encoder=torch.jit.load(str(source),map_location='cpu').eval().float()
cal=json.loads((a.root/'text-calibration-512/manifest.json').read_text())
calphrases={x['phrase'] for x in cal['items']}
words=['person','bus','dog','car','security guard','delivery driver','fire extinguisher',
       'traffic cone','shopping cart','wheelchair','wooden cabinet','exit sign',
       'smoke','flame','package','helmet','red truck','white van','black cat',
       'running child','sitting woman','standing man','office desk','open door',
       'closed window','potted flower','water bottle','monitor screen','safety vest',
       'motorbike rider','bicycle rider','luggage trolley']
phrases=words + [t.format(w) for t in ['a clear image of {}','{} in a room','a distant {}'] for w in words]
if a.heldout:
    tuning=set(phrases)
    phrases=[t.format(w) for t in ['a low resolution photo of {}','{} near the entrance','{} seen from above','{} on a sunny day'] for w in words]
    assert not tuning&set(phrases), 'Heldout overlaps precision-tuning words'
assert len(phrases)==128 and len(set(phrases))==128
assert not set(phrases)&calphrases, 'Validation overlaps calibration'
rows=[]
for i,phrase in enumerate(phrases):
    ids=[tokenizer.encoder['<|startoftext|>']]+tokenizer.encode(phrase)+[tokenizer.encoder['<|endoftext|>']]
    assert len(ids)<=77
    tokens=np.zeros((1,77),dtype=np.int32); tokens[0,:len(ids)]=ids
    with torch.no_grad(): ref=encoder(torch.from_numpy(tokens.astype(np.int64))).numpy()
    assert ref.shape==(1,512) and np.isfinite(ref).all()
    filename=f'{i:03}.npz';np.savez_compressed(a.output/filename,tokens=tokens,reference=ref)
    rows.append({'file':filename,'phrase':phrase,'eot_position':len(ids)-1})
(a.output/'manifest.json').write_text(json.dumps({'scope':'Encoder only, before RepRTA; 128 disjoint real text sequences',
    'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'samples':rows,
    'cpu_oracle_only':True,'calibration_overlap':0,'tuning_overlap':0 if a.heldout else None,
    'heldout':a.heldout},indent=2))
print('128 independent encoder references generated',flush=True)
