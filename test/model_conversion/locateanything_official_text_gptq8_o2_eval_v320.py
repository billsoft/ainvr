"""Evaluation-only contract: installed v284 family with all four decoder groups replaced by the
GPTQ-calibrated per-row INT8 (v307 codes, v318 same-BC opt2 builds, board component parity v319). Quality research only, never an install target.

Vision, embeddings, vocabulary head and generation are unchanged. Each group package holds both AR1 and
prefill256 programs with the original program names. Only the 8 decoder-group specs change; 76/46 kept.
"""
from pathlib import Path
import argparse,hashlib,json,re
ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1');T=ROOT/'test/results'
SELF='locateanything_official_text_gptq8_o2_eval_v320.py';SCHEMA='locateanything_official_text_gptq8_o2_eval_v1'
BASE_FAMILY=BASE/'official-full-family-w8a16-vision-o2-v284.json';FIRST_LOADER='locateanything_official_vision_o2_v284.py';FIRST_LOADER_SHA='de03d67b9d8e5e0d6f50de08a3496a7c79b6226023cc2c250d2b39984b32d465';BASE_CHECK='locateanything_official_vision_recipe_eval_v299.py';BASE_CHECK_SHA='13795e7e467fd4e9d875248a71df0a97f8131233176c0f952cff2d448ba40e81'
GROUPS=((0,8),(9,17),(18,26),(27,35))
def package(first,last):return BASE/f'text-gptq8-group-{first}-{last}-o2-v318-board-package'
def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(4194304),b''):h.update(block)
    return h.hexdigest()
def read(path):return json.loads(Path(path).read_text())
def require_base_family(pin):
    from locateanything_official_vision_recipe_eval_v299 import require_base_family as base_check
    return base_check(pin)
def qualify(manifests):
    out={}
    for (a,b) in GROUPS:
        p=package(a,b);pin=manifests[f'{a}-{b}'];assert digest(p/'manifest.json')==pin
        m=read(p/'manifest.json');assert m['schema']=='locateanything_text_gptq8_group_o2_board_v318' and m['first']==a and m['last']==b and m['bpu_only'] is True
        for n,e in m['files'].items():
            f=p/n;assert f.is_file() and not f.is_symlink() and f.stat().st_size==e['bytes']
            if f.suffix!='.hbm':assert digest(f)==e['sha256']
        assert {x['sequence'] for x in m['profiles']}=={1,256};proof=json.loads((p/'board-proof-v319.json').read_text());assert proof['status']=='completed' and proof['mismatches']==0 and proof['o2_hbm_sha256']==m['o2_hbm_sha256'] and proof['comparisons']==2736;out[(a,b)]=m
    return out
def load_official_generator(path,expected_sha256):
    path=Path(path);assert path.parent.resolve()==BASE and not path.is_symlink() and digest(path)==expected_sha256
    c=read(path);assert c['schema']==SCHEMA and c['evaluation_only'] is True and c['install_allowed'] is False and c['release_approved'] is False
    sources={SELF:digest(CODE/SELF),FIRST_LOADER:FIRST_LOADER_SHA,BASE_CHECK:BASE_CHECK_SHA};assert c['runtime_source_sha256']==sources and all(digest(CODE/n)==p for n,p in sources.items())
    require_base_family(c['base_family']['sha256']);ms=qualify(c['group_manifests'])
    from locateanything_official_vision_o2_v284 import load_official_generator as load_base
    original,_=load_base(BASE_FAMILY,c['base_family']['sha256'])
    from locateanything_official_family_contract_v1 import program
    from locateanything_official_family_v1 import OfficialDecoderGroup,OfficialFullDecoder,OfficialFullBpuGenerator
    groups=list(original.decoder.groups);assert [(g.start,g.end) for g in groups]==list(GROUPS)
    for i,(a,b) in enumerate(GROUPS):
        m=ms[(a,b)];p=package(a,b);meta=dict(path=str(p/'disas.json'),sha256=m['files']['disas.json']['sha256']);specs={}
        for prof in m['profiles']:
            kind='ar' if prof['sequence']==1 else 'prefill'
            specs[kind]=program(f'decoder-group-{a:02d}-{b:02d}-{kind}',p/'model.hbm',m['o2_hbm_sha256'],meta,prof['name'],prof['inputs'],prof['outputs'],['float32']*22,['float32']*19)
        groups[i]=OfficialDecoderGroup(a,b,specs)
    result=OfficialFullBpuGenerator(original.vision,OfficialFullDecoder(groups),original.vocabulary,original.rope,original.image_token_index,original.token_ids)
    old={s.key:s for s in original.specs};new={s.key:s for s in result.specs}
    assert set(old)==set(new) and len(new)==76 and len({str(s.path.resolve()) for s in result.specs})==46
    changed={k for k in old if old[k]!=new[k]};assert changed=={f'decoder-group-{a:02d}-{b:02d}-{k}' for a,b in GROUPS for k in ['ar','prefill']}
    for k in changed:
        for n in ['key','program','input_names','input_shapes','input_dtypes','output_names','output_shapes','output_dtypes']:assert getattr(old[k],n)==getattr(new[k],n),(k,n)
    return result,c
def main():
    ap=argparse.ArgumentParser();ap.add_argument('--out',type=Path,required=True);ap.add_argument('--base-sha',required=True);ap.add_argument('--group-manifests',required=True);a=ap.parse_args()
    manifests=json.loads(a.group_manifests);require_base_family(a.base_sha);qualify(manifests);assert a.out.parent.resolve()==BASE and not a.out.exists()
    c=dict(schema=SCHEMA,architecture='original36_qwen_moonvit27_shared_programs',evaluation_only=True,whole_model_verified=False,release_approved=False,install_allowed=False,
           base_family=dict(path=str(BASE_FAMILY),sha256=a.base_sha),group_manifests=manifests,text_recipe='GPTQ per-row INT8 (v307),official FakeQuantLinear absmax pinned,same-BC opt2',
           runtime_source_sha256={SELF:digest(CODE/SELF),FIRST_LOADER:FIRST_LOADER_SHA,BASE_CHECK:BASE_CHECK_SHA})
    a.out.write_text(json.dumps(c,indent=2)+'\n');load_official_generator(a.out,digest(a.out))
    print(json.dumps(dict(status='constructed_evaluation_only_contract_zero_neural_calls',contract=str(a.out),sha256=digest(a.out))))
if __name__=='__main__':main()
