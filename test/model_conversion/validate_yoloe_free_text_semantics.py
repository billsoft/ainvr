"""AINVR native arbitrary strings -> BPU encoder/RepRTA -> BPU detector."""
import argparse,json,subprocess,hashlib,time
from pathlib import Path
import numpy as np
import hbm_runtime
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--references',type=Path,required=True)
p.add_argument('--text',type=Path,required=True)
p.add_argument('--reprta',type=Path,required=True)
p.add_argument('--detector',type=Path,required=True)
p.add_argument('--python',type=Path,required=True)
p.add_argument('--helper',type=Path,required=True)
p.add_argument('--assets',type=Path,required=True)
p.add_argument('--native-probe',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();assert not a.output.exists()
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
manifest=json.loads((a.references/'manifest.json').read_text());cases=manifest['samples'];assert len(cases)==4
request=a.references/'native-request.json';vectors=a.references/'native-vectors.bin';assert not request.exists() and not vectors.exists()
request.write_text(json.dumps({'groups':[x['phrases'] for x in cases]}))
command=[str(a.native_probe),str(a.text),str(a.reprta),str(a.python),str(a.helper),str(a.assets),str(request),str(vectors)]
begin=time.perf_counter();result=subprocess.run(command,capture_output=True,text=True,timeout=30,check=True)
setup_ms=(time.perf_counter()-begin)*1000
prompts=np.fromfile(vectors,dtype='<f4').reshape(4,1,8,512)
rt=hbm_runtime.HB_HBMRuntime(str(a.detector));assert len(rt.model_names)==1;name=rt.model_names[0];rt.set_scheduling_params(bpu_cores={name:[0]})
rows=[];actuals=[];passed=True;limitations=[]
def box(raw,index):
    x,y,w,h=raw[0,:4,index];return np.array([x-w/2,y-h/2,x+w/2,y+h/2],np.float64)
def overlap(x,y):
    area=np.maximum(np.minimum(x[2:],y[2:])-np.maximum(x[:2],y[:2]),0).prod()
    return float(area/max(np.maximum(x[2:]-x[:2],0).prod()+np.maximum(y[2:]-y[:2],0).prod()-area,1e-12))
for i,item in enumerate(cases):
    data=np.load(a.references/item['file']);ref=data['reference'];inputs={'images':data['image'],'prompt_embeddings':prompts[i]}
    got=next(iter(rt.run({name:inputs})[name].values()));assert got.shape==ref.shape==(1,12,8400) and np.isfinite(got).all()
    maxima=[float(got[0,4+k].max()) for k in range(len(item['phrases']))]
    reference_max=item['fp32_max_scores'];delta=float(np.abs(got[:,4:4+len(maxima)]-ref[:,4:4+len(maxima)]).max())
    passed &= delta<=.15
    matched=[]
    for k in item['required_positive_indices']:
        rindex=int(ref[0,4+k].argmax());gindex=int(got[0,4+k].argmax());iou=overlap(box(ref,rindex),box(got,gindex))
        positive=reference_max[k]>=.25 and maxima[k]>=.25 and iou>=.9;passed &= positive
        matched.append({'phrase':item['phrases'][k],'reference_confidence':reference_max[k],'bpu_confidence':maxima[k],'matched_iou':iou,'passed':bool(positive)})
    if item['negative_only']:passed &= max(reference_max)<.25 and max(maxima)<.25
    if item['image']=='dog' and item['phrases'][0]=='a domestic animal' and reference_max[0]<.25:
        limitations.append('The original FP32 model also misses the domestic-animal description on this dog image at confidence 0.25; not counted as a positive success.')
    rows.append({'image':item['image'],'phrases':item['phrases'],'fp32_max_scores':reference_max,'bpu_max_scores':maxima,'max_probability_error':delta,'required_positives':matched,'negative_only':item['negative_only']});actuals.append(got)
switch_delta=float(np.abs(actuals[0][:,4:]-actuals[1][:,4:]).max());passed &= switch_delta>.1
report={'scope':'Four predeclared free-description cases, including preserved original-model misses; not broad recognition accuracy',
        'detector_hbm_sha256':sha(a.detector),'text_hbm_sha256':sha(a.text),'reprta_hbm_sha256':sha(a.reprta),
        'native_prompt_generation_verified':True,'cpu_neural_fallback':False,'runtime_free_text_verified':bool(passed),
        'same_image_new_phrases_score_delta':switch_delta,'native_cold_four_group_setup_ms':setup_ms,
        'confidence_threshold':.25,'maximum_probability_error_gate':.15,'limitations':limitations,'samples':rows,
        'production_approved':False}
a.output.write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
if not passed:raise SystemExit(2)
