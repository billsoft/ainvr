#!/usr/bin/env python3
"""Compare known RAW fixture/control images; report no-op controls explicitly."""
import argparse
import json
from pathlib import Path
import numpy as np
import cv2
from common import ROOT, digest

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('matrix',type=Path)
    args=parser.parse_args()
    path=args.matrix.resolve()
    if not path.is_relative_to(ROOT/'results'):parser.error('matrix must be inside test/results')
    report=json.loads(path.read_text());rows={r['name']:r for r in report['trials']};effects=[]
    def load(name):
        row=rows[name]
        if row['status']!='PASS':raise ValueError(f'{name} did not pass prerequisite checks')
        result_path=Path(row['result']);folder=result_path.parent
        if not folder.is_relative_to(ROOT/'results'):raise ValueError('Child outside results')
        result=json.loads(result_path.read_text());w=result['parameters']['width'];h=result['parameters']['height']
        frame=sorted(folder.glob('output-*.nv12'))[-1];data=np.fromfile(frame,np.uint8)
        events=[x for c in result['checks'] for x in c.get('detail',{}).get('measurements',[])]
        return folder,data.reshape(h*3//2,w),events,h,w
    for name in rows:
        if not name.endswith('-bypass'):continue
        module=name[:-7];entry={'module':module,'status':'UNVERIFIED'}
        try:
            ref,a,_,h,w=load(module+'-reference');ctl,b,events,h2,w2=load(name)
            if (h,w)!=(h2,w2) or digest(ref/'input.raw')!=digest(ctl/'input.raw'):
                raise ValueError('Control dimensions or input differ')
            delta=np.abs(a.astype(np.int16)-b.astype(np.int16));control=next(x for x in events if x.get('event')=='module_control_readback')
            entry.update(input_sha256=digest(ref/'input.raw'),reference=str(ref),control=str(ctl),
                already_bypassed=control['already_bypassed'],mean_abs_NV12_difference=float(delta.mean()),
                changed_sample_fraction=float((delta>0).mean()),max_sample_difference=int(delta.max()),
                mean_abs_luma_difference=float(delta[:h].mean()))
            entry['status']='DEFAULT_ALREADY_BYPASSED' if control['already_bypassed'] else ('PIXELS_CHANGED' if delta.max() else 'NO_PIXEL_EFFECT_OBSERVED')
            for label,image in [('enabled',a),('bypassed',b)]:
                y=image[:h].astype(np.float32);center=y[h//4:3*h//4,w//4:3*w//4]
                residual=center-cv2.GaussianBlur(center,(9,9),0)
                entry[label+'_central_luma_mean']=float(center.mean())
                entry[label+'_central_highpass_rms']=float(np.sqrt(np.mean(residual**2)))
        except (ValueError,KeyError,StopIteration) as exc:entry['reason']=str(exc)
        effects.append(entry)
    wb={'status':'UNVERIFIED'}
    try:
        ref,a,_,h,w=load('white_balance-reference');ctl,b,events,h2,w2=load('AWB-manual-readback')
        if (h,w)!=(h2,w2) or digest(ref/'input.raw')!=digest(ctl/'input.raw'):raise ValueError('AWB comparison input differs')
        ratios={}
        for label,image in [('unity',a),('red2x_blue0_5x',b)]:
            rgb=cv2.cvtColor(image,cv2.COLOR_YUV2RGB_NV12)
            # Neutral gray is RAW=256. White RAW=900 clips every RGB channel
            # under this calibration and cannot validate a gain change.
            means=rgb[h//4:3*h//4,7*w//8+w//64:w-w//64].mean(axis=(0,1))
            ratios[label]=float((means[0]+1)/(means[2]+1))
        factor=ratios['red2x_blue0_5x']/ratios['unity']
        wb.update(status='PIXEL_RESPONSE_CONFIRMED' if factor>=1.2 else 'NO_SUFFICIENT_PIXEL_RESPONSE',gray_bar_RB=ratios,RB_change_factor=factor)
    except (ValueError,KeyError) as exc:wb['reason']=str(exc)
    result={'module_effects':effects,'manual_AWB':wb,
        'scope':'Known identical RAW fixtures, manual AE/unity AWB. Changed pixels prove a response under this fixture, not calibrated image quality. No-op/default-bypass is not functional acceptance.'}
    output=path.with_name('pixel-effects.json');output.write_text(json.dumps(result,indent=2))
    for row in effects:print(row['module'],row['status'],row.get('mean_abs_luma_difference'))
    print('AWB',wb);print('RESULT',output)

if __name__=='__main__':main()
