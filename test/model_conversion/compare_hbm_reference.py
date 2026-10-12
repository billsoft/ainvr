"""AINVR compare independent BPU outputs against unquantized FP32 references."""
import argparse
import json
from pathlib import Path
import numpy as np
from scipy.optimize import linear_sum_assignment
from scipy.ndimage import gaussian_filter

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--reference',type=Path,required=True)
p.add_argument('--actual',type=Path,required=True)
p.add_argument('--kind',choices=['detection','gpen'],required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args(); assert not a.output.exists()
ref_manifest=json.loads((a.reference/'manifest.json').read_text())
got_manifest=json.loads((a.actual/'manifest.json').read_text())
refs={x['id']:x for x in ref_manifest['samples']}
gots={x['id']:x for x in got_manifest['samples']}
assert refs.keys()==gots.keys() and len(refs)==128
def iou_matrix(x,y):
    top=np.maximum(x[:,None,:2],y[None,:,:2]); bottom=np.minimum(x[:,None,2:4],y[None,:,2:4])
    inter=np.prod(np.maximum(0,bottom-top),axis=-1)
    ax=np.prod(np.maximum(0,x[:,2:4]-x[:,:2]),axis=-1)
    ay=np.prod(np.maximum(0,y[:,2:4]-y[:,:2]),axis=-1)
    return inter/np.maximum(ax[:,None]+ay[None,:]-inter,1e-12)
rows=[]; reference_count=actual_count=matched_count=0; confidences=[]; overlaps=[]
for key in sorted(refs):
    assert refs[key]['input_sha256']==gots[key]['input_sha256'],key
    x=np.load(a.reference/(key+'.npz'))['0'].astype(np.float64)
    y=np.load(a.actual/(key+'.npz'))['0'].astype(np.float64)
    assert x.shape==y.shape and np.isfinite(x).all() and np.isfinite(y).all(),key
    if a.kind=='detection':
        assert x.ndim==3 and x.shape[-1]==6
        x=x[0]; y=y[0]; x=x[x[:,4]>=.25]; y=y[y[:,4]>=.25]
        reference_count+=len(x); actual_count+=len(y); matches=0
        if len(x) and len(y):
            overlap=iou_matrix(x,y)
            same=x[:,None,5]==y[None,:,5]
            cost=1-overlap+1000*(~same)
            ii,jj=linear_sum_assignment(cost)
            for i,j in zip(ii,jj):
                if same[i,j] and overlap[i,j]>=.5:
                    matches+=1; overlaps.append(float(overlap[i,j]))
                    confidences.append(float(abs(x[i,4]-y[j,4])))
        matched_count+=matches
        rows.append({'id':key,'reference_detections':len(x),'actual_detections':len(y),'matches_iou50':matches})
    else:
        assert x.shape==(1,3,256,256)
        mse=float(np.mean((x-y)**2)); psnr=float(10*np.log10(4/max(mse,1e-20)))
        ux=gaussian_filter(x,sigma=(0,0,1.5,1.5)); uy=gaussian_filter(y,sigma=(0,0,1.5,1.5))
        vx=gaussian_filter(x*x,sigma=(0,0,1.5,1.5))-ux*ux
        vy=gaussian_filter(y*y,sigma=(0,0,1.5,1.5))-uy*uy
        cov=gaussian_filter(x*y,sigma=(0,0,1.5,1.5))-ux*uy
        ssim=((2*ux*uy+.0004)*(2*cov+.0036))/((ux*ux+uy*uy+.0004)*(vx+vy+.0036))
        rows.append({'id':key,'psnr_db':psnr,'ssim':float(ssim[:,:,5:-5,5:-5].mean()),
                     'max_channel_mean_error':float(np.max(np.abs(np.mean(x-y,axis=(0,2,3))))),
                     'max_abs_error':float(np.max(np.abs(x-y)))})
if a.kind=='detection':
    precision=matched_count/max(actual_count,1); recall=matched_count/max(reference_count,1)
    metrics={'reference_detections':reference_count,'actual_detections':actual_count,
             'agreement_precision':precision,'agreement_recall':recall,
             'mean_matched_iou':float(np.mean(overlaps)) if overlaps else 0,
             'mean_score_abs_error':float(np.mean(confidences)) if confidences else None}
    passed=reference_count>=32 and precision>=.95 and recall>=.95 and metrics['mean_matched_iou']>=.9
else:
    metrics={'median_psnr_db':float(np.median([r['psnr_db'] for r in rows])),
             'p05_psnr_db':float(np.percentile([r['psnr_db'] for r in rows],5)),
             'mean_ssim':float(np.mean([r['ssim'] for r in rows])),
             'max_channel_mean_error':max(r['max_channel_mean_error'] for r in rows)}
    passed=metrics['median_psnr_db']>=35 and metrics['p05_psnr_db']>=28 and metrics['mean_ssim']>=.98 and metrics['max_channel_mean_error']<=.03
report={'kind':a.kind,'samples':len(rows),'metrics':metrics,'quantization_parity_passed':passed,
        'note':'Agreement with FP32 is not ground-truth accuracy. Visual and real-channel checks remain required.',
        'reference_model_sha256':ref_manifest['onnx_sha256'],'hbm_sha256':got_manifest['model_sha256'],
        'board_fps':got_manifest['sequential_fps'],'production_approved':False,'rows':rows}
a.output.write_text(json.dumps(report,indent=2))
print(json.dumps({k:report[k] for k in ['metrics','quantization_parity_passed','board_fps']}),flush=True)
