"""Re-score stored answers against the native BF16 reference at several IoU thresholds (no inference)."""
import json,ast,re,math
from pathlib import Path
B=Path('/work/official-llm-v1');D=B/'ref160-v303'
ref=json.loads((D/'independent-final-native-reference-v2-head-o2/reference-index-v3.json').read_text())['cases']
H=B/'validate_locateanything_official_heldout_bpu_v2.py';tree=ast.parse(H.read_text());nodes=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name in {'parse_response','iou','maximum_matches'}];f=dict(re=re);exec(compile(ast.Module(body=nodes,type_ignores=[]),str(H),'exec'),f)
parse,iou,match=f['parse_response'],f['iou'],f['maximum_matches']
full=[c['answer']['response'] if c.get('rpc_ok') else '' for c in json.loads((D/'vision-o2-frozen160-v285/status.json').read_text())['cases']]
dep=[c['response'] for c in json.loads((B/'vision-text-attribution160-v303-deployed/status.json').read_text())['cases']]
cand=[c['response'] for c in json.loads((B/'vision-text-attribution160-v303-candidate/status.json').read_text())['cases']]
def score(ans,t):
 m=p=q=0;cnt_ok=cnt=0
 for c,a in zip(ref,ans):
  if str(c['reference_eligible'])!='True' or c['kind']!='box':continue
  R=parse(c['response'])['boxes'];C=parse(a)['boxes'];m+=len(match(R,C,lambda x,y:iou(x,y)>=t));p+=len(C);q+=len(R);cnt+=1;cnt_ok+=int(len(C)==len(R))
 return dict(P=round(m/p,4),R=round(m/q,4),count_equal_cases=f'{cnt_ok}/{cnt}')
out={}
g8=[c['answer']['response'] if c.get('rpc_ok') else '' for c in json.loads((D/'text-gptq8-eval160-v314-status.json').read_text())['cases']]
for name,ans in [('full_bpu_gptq8',g8),('full_bpu_deployed',full),('bpu_vision_bf16_text',dep),('candidate_vision_bf16_text',cand)]:
 out[name]={str(t):score(ans,t) for t in [0.5,0.75,0.9]}
print(json.dumps(out,indent=1));(B/'rescore-iou-thresholds-v317.json').write_text(json.dumps(out,indent=2)+'\n')
