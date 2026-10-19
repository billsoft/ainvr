"""Evaluation-only contract: installed v284 family with the 27 MoonViT blocks replaced by the
INT8-weight qk16x16/sv16x16 recipe (opt0 HBM). Quality research only, never an install target.

The base family must be the installed v284 (bound to its v288 install and v285/v286 full160 proof).
Component admission is the actual board capture v297: deterministic repeats and a byte-exact
control of the deployed vision. Only the 27 vision-block specs change; 76 programs/46 HBMs remain.
"""
from pathlib import Path
import argparse,hashlib,json,re

ROOT=Path('/home/sunrise/ainvr');CODE=ROOT/'test/model_conversion';BASE=Path('/mnt/ainvr-ssd/model-compile-candidates/locateanything-3b-w4-v1');T=ROOT/'test/results'
SELF='locateanything_official_vision_recipe_eval_v299.py';SCHEMA='locateanything_official_vision_recipe_eval_v1'
BASE_FAMILY=BASE/'official-full-family-w8a16-vision-o2-v284.json';FIRST_LOADER='locateanything_official_vision_o2_v284.py';FIRST_LOADER_SHA='de03d67b9d8e5e0d6f50de08a3496a7c79b6226023cc2c250d2b39984b32d465'
PACKAGE=BASE/'vision-all27-qk16sv16-o0-v296-board-package';PACKAGE_MANIFEST_SHA='04d0a1a8ac00b35dce81ed70921b9f9f6d654f0994a9ab032d10a4f169bce414'
CAPTURE=BASE/'vision-all27-qk16sv16-o0-v296-board-package-features-v297/status.json';CAPTURE_SHA='869677ac38274b0b458e22b985dcad8a8a3cb6d6872d3588fe920cce94b3aa0e';CAPTURE_SOURCE_SHA='8c079a31f70a25fa758c1c98bb7a9648c56e9d68b0edf5dc7358d059891774a5'
VISION_KEYS={f'vision-block-{i:02d}' for i in range(27)}
def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(4194304),b''):h.update(block)
    return h.hexdigest()
def read(path):return json.loads(Path(path).read_text())

def require_base_family(pin):
    assert isinstance(pin,str) and re.fullmatch('[0-9a-f]{64}',pin) and digest(BASE_FAMILY)==pin
    installed=read(T/'locateanything-vision-o2-runtime-upgrade-v288.json');q=read(T/'locateanything-vision-o2-full160-guard-v286.json');raw=read(BASE/'vision-o2-frozen160-v285/status.json')
    assert digest(T/'locateanything-vision-o2-runtime-upgrade-v288.json')=='7c4ae564129ab3660adb3d0447e44fc4e2bb307e4bafa790d86b08d3c417e79b'
    assert installed['status']=='installed_vision_o2_trial_and_current_native_results_real_SEI_verified' and installed['admission']['contract_sha256']==pin
    assert installed['admission']['quality_report_sha256']==digest(T/'locateanything-vision-o2-full160-guard-v286.json')=='45635bca43ada0f69f439b556fc865b6985ba4b8534be1f95199b7dcb223d9be'
    assert q['status']=='completed_all160_runtime_equivalence_not_installed' and q['raw_sha256']==digest(BASE/'vision-o2-frozen160-v285/status.json')
    assert raw['contract_sha256']==pin and raw['runtime_equivalence_passed'] is True and raw['retained_failed_indices']==[117] and len(raw['cases'])==160
    return installed

def qualify():
    assert digest(PACKAGE/'manifest.json')==PACKAGE_MANIFEST_SHA and digest(CAPTURE)==CAPTURE_SHA
    m=read(PACKAGE/'manifest.json');assert m['schema']=='locateanything_vision_recipe_board_v296' and len(m['programs'])==27 and len(m['components'])==27
    for n,e in m['files'].items():
        p=PACKAGE/n;assert p.is_file() and not p.is_symlink() and p.stat().st_size==e['bytes']
        if p.suffix!='.hbm':assert digest(p)==e['sha256']
    cap=read(CAPTURE);assert cap['status']=='completed' and cap['source_sha256']==CAPTURE_SOURCE_SHA and cap['candidate_manifest_sha256']==PACKAGE_MANIFEST_SHA
    assert cap['control_matches_v1'] is True and len(cap['cases'])==17 and cap['bpu_calls']==17*2*2*29 and cap['all_owned_models_released']
    return m

def load_official_generator(path,expected_sha256):
    path=Path(path);assert path.parent.resolve()==BASE and not path.is_symlink() and digest(path)==expected_sha256
    c=read(path);assert c['schema']==SCHEMA and c['evaluation_only'] is True and c['release_approved'] is False and c['install_allowed'] is False
    sources={SELF:digest(CODE/SELF),FIRST_LOADER:FIRST_LOADER_SHA};assert c['runtime_source_sha256']==sources and all(digest(CODE/n)==p for n,p in sources.items())
    require_base_family(c['base_family']['sha256']);assert c['base_family']==dict(path=str(BASE_FAMILY),sha256=c['base_family']['sha256'])
    m=qualify()
    from locateanything_official_vision_o2_v284 import load_official_generator as load_base
    original,_=load_base(BASE_FAMILY,c['base_family']['sha256'])
    from locateanything_official_family_contract_v1 import program
    from locateanything_official_family_v1 import OfficialVisionBlock,OfficialFullBpuGenerator
    from locateanything_bpu_vision_v1 import FullVision
    meta=dict(path=str(PACKAGE/'disas.json'),sha256=m['files']['disas.json']['sha256']);stages=original.vision.stages;blocks=[]
    for i,p in enumerate(m['programs']):
        old=stages[1+i].spec;assert old.key==f'vision-block-{i:02d}' and old.program==p['name']
        blocks.append(OfficialVisionBlock(i,program(old.key,PACKAGE/'official-q8/model.hbm',m['files']['official-q8/model.hbm']['sha256'],meta,p['name'],p['inputs'],p['outputs'],['float32'],['float32'])))
    result=OfficialFullBpuGenerator(FullVision(stages[0],blocks,stages[-1]),original.decoder,original.vocabulary,original.rope,original.image_token_index,original.token_ids)
    old={s.key:s for s in original.specs};new={s.key:s for s in result.specs}
    assert set(old)==set(new) and len(new)==76 and len({str(s.path.resolve()) for s in result.specs})==46
    assert {k for k in old if old[k]!=new[k]}==VISION_KEYS
    return result,c

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--out',type=Path,required=True);ap.add_argument('--base-sha',required=True);a=ap.parse_args()
    require_base_family(a.base_sha);qualify();assert a.out.parent.resolve()==BASE and not a.out.exists()
    c=dict(schema=SCHEMA,architecture='original36_qwen_moonvit27_shared_programs',evaluation_only=True,whole_model_verified=False,release_approved=False,install_allowed=False,
           base_family=dict(path=str(BASE_FAMILY),sha256=a.base_sha),vision_recipe='INT8 per-channel weights;qk16x16;sv16x16;opt0',
           runtime_source_sha256={SELF:digest(CODE/SELF),FIRST_LOADER:FIRST_LOADER_SHA})
    a.out.write_text(json.dumps(c,indent=2)+'\n');load_official_generator(a.out,digest(a.out))
    print(json.dumps(dict(status='constructed_evaluation_only_contract_zero_neural_calls',contract=str(a.out),sha256=digest(a.out))))
if __name__=='__main__':main()
