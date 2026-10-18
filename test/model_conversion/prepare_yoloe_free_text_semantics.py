"""AINVR original FP32 references for predeclared non-COCO free descriptions."""
import argparse,json,hashlib,sys
from pathlib import Path
import numpy as np
import torch
from ultralytics import YOLOE
import onnxruntime as ort
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--root',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--prompt-slots',type=int,choices=[8,32],default=8)
p.add_argument('--detector-onnx',type=Path)
a=p.parse_args();a.output.mkdir(exist_ok=False);torch.set_num_threads(2)
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
assert sha(a.root/'yoloe-26x-seg.pt')=='d08d390a08f98195f7c87807839fe4ff93a5491645fef1bc3bf0700efafdd639'
encoder=torch.jit.load(str(a.root/'mobileclip2_b.ts'),map_location='cpu').eval().float()
head=YOLOE(str(a.root/'yoloe-26x-seg.pt')).model.eval().float().model[-1]
sys.path.insert(0,str(a.root/'clip-tokenizer'))
from simple_tokenizer import SimpleTokenizer
tokenizer=SimpleTokenizer(str(a.root/'clip-tokenizer/bpe_simple_vocab_16e6.txt.gz'))
options=ort.SessionOptions();options.intra_op_num_threads=2;options.inter_op_num_threads=1
model=a.detector_onnx or a.root/'onnx-probe-v1/yoloe26x-runtime-8prompts.onnx'
session=ort.InferenceSession(str(model),options,providers=['CPUExecutionProvider'])
# All queries/case intentions are fixed before either FP32 or BPU evaluation.
cases=[('bus-person',['a passenger bus','a pedestrian'],[0]),
       ('bus-person',['an airplane','a forklift'],[]),
       ('dog',['a domestic animal','a parked vehicle'],[]),
       ('dog',['a passenger bus','a pedestrian'],[])]
rows=[]
for i,(image,phrases,required) in enumerate(cases):
    tokens=np.zeros((len(phrases),77),np.int64)
    for j,phrase in enumerate(phrases):
        ids=[49406]+tokenizer.encode(phrase)+[49407];assert len(ids)<=77
        tokens[j,:len(ids)]=ids
    with torch.no_grad():raw=encoder(torch.from_numpy(tokens));transformed=head.get_tpe(raw.unsqueeze(0)).numpy()
    prompts=np.zeros((1,a.prompt_slots,512),np.float32);prompts[:,:len(phrases)]=transformed
    path=a.root/'semantic-inputs'/(image+'.bin');pixels=np.fromfile(path,dtype='<f4').reshape(1,3,640,640)
    output=session.run(None,{'images':pixels,'prompt_embeddings':prompts})[0]
    filename=f'{i:03}.npz';np.savez_compressed(a.output/filename,image=pixels,prompts=prompts,reference=output)
    rows.append({'file':filename,'image':image,'image_sha256':sha(path),'phrases':phrases,
                 'required_positive_indices':required,'negative_only':i==1,
                 'fp32_max_scores':[float(output[0,4+j].max()) for j in range(len(phrases))]})
report={'scope':'Predeclared free-description semantic switch on real images; small functionality set, not broad accuracy',
        'prompt_slots':a.prompt_slots,'source_onnx_sha256':sha(model),'samples':rows,'production_approved':False}
(a.output/'manifest.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
