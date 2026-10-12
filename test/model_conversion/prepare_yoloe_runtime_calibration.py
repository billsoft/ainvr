"""AINVR actual MobileCLIP2/RepRTA references and varying YOLOE prompt inputs.

Offline host oracle only. Never serves cached vectors as arbitrary-text support.
Image tensors are the existing disjoint 512/128 COCO preprocessing dataset.
"""
import argparse,hashlib,json,sys,time
from pathlib import Path
import numpy as np
import torch
import torch.nn.functional as F
from torch import nn
from ultralytics import YOLOE
import onnxruntime as ort
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--root',type=Path,required=True)
p.add_argument('--image-manifest',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();a.output.mkdir(exist_ok=False);torch.set_num_threads(2)
sha=lambda x:hashlib.sha256(x.read_bytes()).hexdigest()
assert sha(a.root/'yoloe-26x-seg.pt')=='d08d390a08f98195f7c87807839fe4ff93a5491645fef1bc3bf0700efafdd639'
assert sha(a.root/'mobileclip2_b.ts')=='35d7f213e4d75f38514e4656ad3cb91158bd33e3805d8ac349f23b186f66982f'
sys.path.insert(0,str(a.root/'clip-tokenizer'))
from simple_tokenizer import SimpleTokenizer
tokenizer=SimpleTokenizer(str(a.root/'clip-tokenizer/bpe_simple_vocab_16e6.txt.gz'))
encoder=torch.jit.load(str(a.root/'mobileclip2_b.ts'),map_location='cpu').eval().float()
head=YOLOE(str(a.root/'yoloe-26x-seg.pt')).model.eval().float().model[-1]
class RepRta(nn.Module):
    def __init__(self,module):super().__init__();self.module=module
    def forward(self,embeddings):return F.normalize(self.module(embeddings),dim=-1,p=2)
network=RepRta(head.reprta).eval()
def encode(phrases):
    tokens=torch.zeros(len(phrases),77,dtype=torch.long)
    for i,phrase in enumerate(phrases):
        ids=[tokenizer.encoder['<|startoftext|>']]+tokenizer.encode(phrase)+[tokenizer.encoder['<|endoftext|>']]
        assert len(ids)<=77;tokens[i,:len(ids)]=torch.tensor(ids)
    values=[]
    with torch.no_grad():
        for i in range(0,len(phrases),16):values.append(encoder(tokens[i:i+16]).cpu().numpy())
    return np.concatenate(values),tokens.numpy()
class_names=json.loads((a.root/'coco80-export-summary.json').read_text())['class_names'];assert len(class_names)==80
raw,tokens=encode(class_names)
with torch.no_grad():
    expected=head.get_tpe(torch.from_numpy(raw).unsqueeze(0));got=network(torch.from_numpy(raw).unsqueeze(0))
assert torch.equal(expected,got)
vectors=got.numpy();np.savez_compressed(a.output/'coco80-prompt-oracle.npz',raw=raw,tokens=tokens,prompt_embeddings=vectors,class_names=np.array(class_names))
sample=torch.from_numpy(raw[:8]).unsqueeze(0)
model=a.output/'yoloe-reprta-8prompts.onnx'
torch.onnx.export(network,(sample,),str(model),input_names=['text_embeddings'],output_names=['prompt_embeddings'],opset_version=17,dynamo=False)
opts=ort.SessionOptions();opts.intra_op_num_threads=2;opts.inter_op_num_threads=1
session=ort.InferenceSession(str(model),opts,providers=['CPUExecutionProvider'])
cal=json.loads((a.root/'text-calibration-512/manifest.json').read_text());phrases=[x['phrase'] for x in cal['items']];assert len(phrases)==512
raw_cal,_=encode(phrases);caldir=a.output/'reprta-calibration';caldir.mkdir()
for i in range(64):np.save(caldir/f'{i:03}.npy',raw_cal[i*8:(i+1)*8].reshape(1,8,512))
calmeta={'phrases':phrases,'samples':64,'scope':'512 real calibration phrases, eight raw encoder vectors per RepRTA input'}
(caldir/'manifest.json').write_text(json.dumps(calmeta,indent=2))
reference=a.output/'reprta-heldout';reference.mkdir();errors=[]
held=json.loads((a.root/'text-heldout-128-v2/manifest.json').read_text());assert held['heldout'] and held['tuning_overlap']==0
for i in range(16):
    group=held['samples'][i*8:(i+1)*8]
    input_=np.concatenate([np.load(a.root/'text-heldout-128-v2'/x['file'])['reference'] for x in group]).reshape(1,8,512)
    with torch.no_grad():ref=head.get_tpe(torch.from_numpy(input_)).numpy()
    output=session.run(None,{'text_embeddings':input_})[0]
    error=float(np.max(np.abs(ref-output)));assert error<1e-5;errors.append(error)
    np.savez_compressed(reference/f'{i:03}.npz',input=input_,reference=ref,phrases=np.array([x['phrase'] for x in group]))
manifest=json.loads(a.image_manifest.read_text());rows=[];rng=np.random.default_rng(20261013)
for split,count in [('calibration',512),('validation',128)]:
    out=a.output/('detector-prompts-'+split);out.mkdir()
    images=[x for x in manifest['items'] if x['split']==split];assert len(images)==count
    for i,item in enumerate(images):
        positive=list(dict.fromkeys(item['classes']));rng.shuffle(positive)
        selected=positive[:8]
        for c in rng.permutation(80).tolist():
            if len(selected)==8:break
            if c not in selected:selected.append(c)
        assert len(selected)==8
        # Include real examples of inactive slots; the runtime must ignore them.
        active=8 if i%4 else 1+i%7
        prompt=np.zeros((1,8,512),dtype=np.float32);prompt[:,:active]=vectors[:,selected[:active]]
        file=Path(item['tensor'].replace('\\','/')).name;filename=Path(file).stem+'.bin';prompt.tofile(out/filename)
        rows.append({'split':split,'image_tensor':file,'image_sha256':item['tensor_sha256'],
                     'prompt_file':str(out.relative_to(a.output)/filename),'prompt_sha256':sha(out/filename),
                     'class_ids':selected,'class_names':[class_names[x] for x in selected],
                     'active_count':active,'source_classes':item['classes']})
r={'state':'prepared','scope':'Actual FP32 text/RepRTA oracle and dynamic prompt calibration only; no complete YOLOE BPU approval',
   'production_approved':False,'reprta_onnx_sha256':sha(model),'reprta_onnx_max_error':max(errors),
   'image_manifest_sha256':sha(a.image_manifest),'calibration_images':512,'validation_images':128,
   'detector_onnx_sha256':sha(a.root/'onnx-probe-v1/yoloe26x-runtime-8prompts.onnx'),
   'prompt_contract':'Raw MobileCLIP2 normalized embeddings -> matching RepRTA + L2 -> final vectors; zero unused slots',
   'samples':rows}
(a.output/'manifest.json').write_text(json.dumps(r,indent=2));print(json.dumps({k:v for k,v in r.items() if k!='samples'}),flush=True)
