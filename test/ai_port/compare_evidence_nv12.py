"""CPU JPEG decoder is a test oracle only; production capture stays GLES/JPU."""
import argparse,json,math
from pathlib import Path
import numpy as np
from PIL import Image
parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('directory',type=Path);args=parser.parse_args();p=args.directory
report=json.loads((p/'report.json').read_text());assert report['cpu_image_fallback'] is False
rows=report['rows'];assert len(rows)==4;assert len({(x['source_bt709'],x['source_full_range']) for x in rows})==4
metrics=[]
for row in rows:
 n=row['frame'];reference=np.asarray(Image.open(p/f'{n}-reference.jpg').convert('RGB')).astype(np.float32);direct=np.asarray(Image.open(p/f'{n}-direct.jpg').convert('RGB')).astype(np.float32)
 assert reference.shape==direct.shape==(row['height'],row['width'],3)
 diff=np.abs(reference-direct);mse=float(np.mean((reference-direct)**2));psnr=None if mse==0 else 10*math.log10(255**2/mse)
 metrics.append({'frame':n,'mae':float(diff.mean()),'p99_abs':float(np.percentile(diff,99)),'psnr_db':psnr,'reference_ms_warm':sum(row['reference_ms'][1:])/2,'direct_ms_warm':sum(row['direct_ms'][1:])/2,'passed':float(diff.mean())<=3 and (psnr is None or psnr>=35)})
result={'scope':'JPEG reconstruction agreement on identical frames, not model accuracy; CPU decoder is test-only','passed':all(x['passed'] for x in metrics),'metrics':metrics};(p/'comparison.json').write_text(json.dumps(result,indent=2));print(json.dumps(result));raise SystemExit(0 if result['passed'] else 1)
