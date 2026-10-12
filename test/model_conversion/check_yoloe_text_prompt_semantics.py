"""AINVR offline real-text/real-image check of the two-input YOLOE ONNX.

This uses CPU reference inference on the development computer only. It does
not enable CPU inference on the board or certify a full BPU YOLOE detector.
"""
import argparse,hashlib,json,sys,time
from pathlib import Path
import numpy as np
import torch
import onnxruntime as ort
from ultralytics import YOLOE

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--root',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();a.output.mkdir(exist_ok=False);torch.set_num_threads(2)
sys.path.insert(0,str(a.root/'clip-tokenizer'))
from simple_tokenizer import SimpleTokenizer
tokenizer=SimpleTokenizer(str(a.root/'clip-tokenizer/bpe_simple_vocab_16e6.txt.gz'))
core=YOLOE(str(a.root/'yoloe-26x-seg.pt')).model.eval().float()
assert getattr(core,'text_model')=='mobileclip2:b'
head=core.model[-1];head.end2end=False;head.nc=8;head.export=True;head.format='onnx';head.dynamic=False
encoder=torch.jit.load(str(a.root/'mobileclip2_b.ts'),map_location='cpu').eval().float()
opts=ort.SessionOptions();opts.intra_op_num_threads=2;opts.inter_op_num_threads=1
model=a.root/'onnx-probe-v1/yoloe26x-runtime-8prompts.onnx'
session=ort.InferenceSession(str(model),opts,providers=['CPUExecutionProvider'])
vocabularies=[['person','bus'],['dog','car']];embeddings=[]
for names in vocabularies:
    tokens=torch.zeros(len(names),77,dtype=torch.long)
    for i,name in enumerate(names):
        ids=[tokenizer.encoder['<|startoftext|>']]+tokenizer.encode(name)+[tokenizer.encoder['<|endoftext|>']]
        assert len(ids)<=77;tokens[i,:len(ids)]=torch.tensor(ids)
    with torch.no_grad():
        raw=encoder(tokens);final=head.get_tpe(raw.unsqueeze(0)).cpu().numpy()
    padded=np.zeros((1,8,512),dtype=np.float32);padded[:,:len(names)]=final
    embeddings.append(padded)
    np.savez_compressed(a.output/('prompts-'+names[0]+'.npz'),prompt_embeddings=padded,active_count=np.array(len(names)),class_names=np.array(names),tokens=tokens.numpy())
rows=[]
for case in ['bus-person','dog']:
    source=a.root/'semantic-inputs'/(case+'.bin');image=np.fromfile(source,dtype='<f4').reshape(1,3,640,640)
    for names,prompt in zip(vocabularies,embeddings):
        got=session.run(None,{'images':image,'prompt_embeddings':prompt})[0]
        with torch.no_grad():
            ref=core.predict(torch.from_numpy(image),vpe=torch.from_numpy(prompt))[0][:,:12,:].numpy()
        assert np.isfinite(got).all()
        # Box coordinates are pixels; dense near-zero coordinates make a
        # blanket relative comparison misleading. Bound geometric drift and
        # class probability drift separately, including low-confidence rows.
        box_error=float(np.max(np.abs(got[:,:4]-ref[:,:4])))
        score_error=float(np.max(np.abs(got[:,4:]-ref[:,4:])))
        assert box_error<.05 and score_error<1e-4,(box_error,score_error)
        scores={n:float(got[0,4+i].max()) for i,n in enumerate(names)}
        rows.append({'image_case':case,'vocabulary':names,'maximum_class_scores':scores,'max_box_error_pixels':box_error,'max_probability_error':score_error,'input_sha256':hashlib.sha256(source.read_bytes()).hexdigest()})
        np.savez_compressed(a.output/(case+'-'+names[0]+'.npz'),output=got)
assert next(x for x in rows if x['image_case']=='bus-person' and x['vocabulary'][0]=='person')['maximum_class_scores']['bus']>.25
dog_score=next(x for x in rows if x['image_case']=='dog' and x['vocabulary'][0]=='dog')['maximum_class_scores']['dog']
r={'timestamp':time.time(),'scope':'Two actual user COCO validation images and two real English vocabularies, offline CPU oracle only; not a complete accuracy benchmark',
   'model_onnx_sha256':hashlib.sha256(model.read_bytes()).hexdigest(),'text_encoder_sha256':hashlib.sha256((a.root/'mobileclip2_b.ts').read_bytes()).hexdigest(),
   'onnx_real_text_switch_verified':True,'full_yoloe_hbm_verified':False,'text_encoder_BPU_verified':False,'production_approved':False,
   'positive_case_bus_threshold025_passed':True,
   'dog_case_threshold025_passed':dog_score>.25,
   'dog_case_note':'The selected panoramic COCO dog sample did not pass 0.25 in the first smoke run. Preserve its actual score and matching FP32 result; this is not an all-case accuracy pass.',
   'prompt_contract':'MobileCLIP2-B token encoding, then the matching YOLOE head RepRTA and L2 normalization; fixed eight slots, ignore inactive class slots',
   'parity_limits':{'maximum_coordinate_error_pixels':.05,'maximum_probability_error':1e-4},
   'initial_blanket_allclose_failure':'First real image had 0.015 pixel worst dense-box drift and 2.92e-6 probability error; initial blanket allclose failed near zero coordinates. Separate explicit geometric/probability checks applied, not a BPU quantization gate change.',
   'cases':rows}
(a.output/'report.json').write_text(json.dumps(r,indent=2));print(json.dumps(r,indent=2),flush=True)
