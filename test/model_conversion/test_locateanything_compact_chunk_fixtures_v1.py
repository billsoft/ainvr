"""Real old-capture chunk-placement controls; zero neural/compiler simulation calls."""
from pathlib import Path
import hashlib,json,time
import numpy as np
from prepare_locateanything_compact_profile_proof_v4 import fixture_arrays

ROOT=Path('/work/official-llm-v1')
OUT=ROOT/'locateanything-compact-chunk-fixture-controls-v1.json'
assert not OUT.exists()
sha=lambda p:hashlib.sha256(Path(p).read_bytes()).hexdigest()
report=dict(status='checking',started=time.time(),source_sha256=sha(__file__),
  fixture_source_sha256=sha(ROOT/'prepare_locateanything_compact_profile_proof_v4.py'),
  controls=[],neural_calls=0,compiler_simulation_calls=0,
  whole_model_verified=False,release_approved=False)
config=json.loads(Path('/model/config.json').read_text())['text_config']
baseline=Path('/opt/locate-profile-proof-compact-profile-generic-block0-s1-positive-v2/fixtures')
old=json.loads((baseline/'status.json').read_text())
for index,case in enumerate(old['cases']):
    arrays,refs,meta=fixture_arrays(0,0,1,case['image_id'],case['call'],0,config)
    assert len(arrays)==len(case['inputs'])==6
    for array,entry in zip(arrays,case['inputs']):
        previous=np.load(baseline/entry['file'],allow_pickle=False)
        assert np.array_equal(array,previous)
    report['controls'].append(dict(kind='legacy_AR_inputs_byte_equal',image=case['image_id'],call=case['call'],arrays=len(arrays)))
for start,end in [(0,0),(0,8),(27,35)]:
    count=end-start+1
    for image in [1144,2444]:
        full,refs,metadata=fixture_arrays(start,end,256,image,0,0,config)
        available=metadata['query_rows']
        for row in [0,60,((available-1)//12)*12]:
            arrays,part_refs,meta=fixture_arrays(start,end,12,image,0,row,config)
            q=meta['query_rows'];p=meta['past_length']
            assert p==row and q==min(12,available-row)
            assert np.array_equal(arrays[0][:q],full[0][row:row+q])
            assert np.array_equal(arrays[1][:q],full[1][row:row+q])
            assert np.array_equal(arrays[2][:q],full[2][row:row+q])
            assert np.count_nonzero(arrays[0][q:])==0
            logical=full[3][row:row+q,256:256+p+q]
            prepared=np.concatenate([arrays[3][:q,512-12-p:512-12],arrays[3][:q,512-12:512-12+q]],axis=1)
            assert np.array_equal(logical,prepared)
            if q<12:
                assert np.all(arrays[3][q:,0]==0) and np.all(arrays[3][q:,1:]==-32767)
            for i in range(count):
                for cache,reference in [(arrays[4+i],refs[1+i]),(arrays[4+count+i],refs[1+count+i])]:
                    if p:assert np.array_equal(cache[:,512-p:],reference[:,:p])
                    assert np.count_nonzero(cache[:,:512-p])==0
                assert np.array_equal(part_refs[1+i],refs[1+i][:,row:row+q])
                assert np.array_equal(part_refs[1+count+i],refs[1+count+i][:,row:row+q])
            assert np.array_equal(part_refs[0],refs[0][row:row+q])
            report['controls'].append(dict(kind='native_chunk_prefix_rope_mask_padding',layers=[start,end],image=image,row_start=row,query_rows=q,past_length=p,cache_arrays=2*count))
bad=[(0,0,12,1144,0,10000,config),(0,0,256,1144,0,1,config)]
for arguments in bad:
    try:fixture_arrays(*arguments)
    except AssertionError:report['controls'].append(dict(kind='invalid_range_rejected',sequence=arguments[2],row_start=arguments[5]))
    else:raise AssertionError('Invalid chunk accepted')
report.update(status='passed',control_count=len(report['controls']),finished=time.time())
OUT.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({k:report[k] for k in ['status','control_count','neural_calls','compiler_simulation_calls']}))
