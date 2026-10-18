"""Package completed compact AR/prefill groups, including S12 causal chunks.

CPU compiler simulation only. No GPU,final images or production actions.
Native BF16 comparison is isolated-group numerical diagnosis,not box P/R.
"""
from pathlib import Path
import argparse,hashlib,json,os,shutil,sys,tarfile,time,traceback
os.environ['OMP_NUM_THREADS']='2';os.environ['OPENBLAS_NUM_THREADS']='2';os.environ['CUDA_VISIBLE_DEVICES']=''
sys.path.insert(0,'/opt/locate-oellm-research-v1/sdk448-isolated/python')
from locateanything_compact_compiler_origin_v1 import verify_compiler_origin
import numpy as np,torch
from hbdk4.compiler import load
torch.set_num_threads(2);assert not torch.cuda.is_initialized()
BUILDER_SHA='dc65fb759764d89a9c026ae05a3171c0931888343cf1dca3124f9439e3f4067d'
CHECKPOINT_SHA='6fbd345d8e7e8b66d830bad4e68a806c4ccd36005192ae8593b27756e64d4825'

def sha(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def metric(a,b):
    a=np.asarray(a,np.float64);b=np.asarray(b,np.float64)
    assert a.shape==b.shape and np.isfinite(a).all() and np.isfinite(b).all()
    return dict(maxabs=float(np.abs(a-b).max()),relative_l2=float(np.linalg.norm(a-b)/max(np.linalg.norm(b),1e-20)),array_equal=bool(np.array_equal(a,b)))

def fixture_arrays(start,end,seq,image,call,row_start,config):
    """Use original native histories; this is isolated-group, not chained quality."""
    count=end-start+1
    assert count in [1,2,9] and seq in [1,12,256]
    roots=[Path('/work/all-decoder-layer-captures-v1')/f'gptq-bf16-{image}-slow'/f'block{i}-call-{call}' for i in range(start,end+1)]
    def data(i,name):return np.load(roots[i]/(name+'.npy'),allow_pickle=False)
    available=data(0,'hidden_states').shape[1]
    assert 0<=row_start<available and (seq==12 or row_start==0)
    q=min(seq,available-row_start)
    assert seq!=1 or q==1
    hidden=np.zeros((seq,2048),np.float32)
    hidden[:q]=data(0,'hidden_states')[0,row_start:row_start+q]
    positions=np.zeros(seq,np.int64)
    positions[:q]=data(0,'position_ids').reshape(-1)[row_start:row_start+q]
    angles=torch.from_numpy(positions).float()[:,None]*(1/(config['rope_theta']**(torch.arange(0,128,2).float()/128)))[None,:]
    angles=torch.cat([angles,angles],-1)
    cos=angles.cos().bfloat16().float().numpy();sin=angles.sin().bfloat16().float().numpy()
    keys=[];values=[];native_keys=[];native_values=[];past=None;original_past=None
    for i,source in enumerate(roots):
        assert data(i,'hidden_states').shape[1]==available
        oldk=data(i,'past-0')[0] if (source/'past-0.npy').exists() else np.empty((2,0,128),np.float32)
        oldv=data(i,'past-1')[0] if (source/'past-1.npy').exists() else np.empty((2,0,128),np.float32)
        if original_past is None:original_past=oldk.shape[1]
        assert oldk.shape==oldv.shape==(2,original_past,128)
        pk,pv=data(i,'present-0')[0],data(i,'present-1')[0]
        assert pk.shape==pv.shape==(2,original_past+available,128)
        # Later chunks receive original native history, never future rows.
        retained_key=pk[:,:original_past+row_start] if row_start else oldk
        retained_value=pv[:,:original_past+row_start] if row_start else oldv
        if past is None:past=retained_key.shape[1]
        assert retained_key.shape==retained_value.shape==(2,past,128) and past+seq<=512
        key=np.zeros((2,512,128),np.float32);value=np.zeros_like(key)
        if past:key[:,512-past:]=retained_key;value[:,512-past:]=retained_value
        keys.append(key);values.append(value)
        native_keys.append(pk[:,past:past+q].copy());native_values.append(pv[:,past:past+q].copy())
    assert seq in [1,12] or past==0
    mask=np.full((seq,512),-32767.,np.float32)
    if (roots[0]/'attention_mask.npy').exists():
        native_mask=data(0,'attention_mask')[0,0]
        valid=native_mask[row_start:row_start+q,:past+q].clip(-32767.,0.)
        assert np.all(native_mask[row_start:row_start+q,past+q:]<0)
    else:valid=np.where(np.arange(past+q)[None,:]<=past+np.arange(q)[:,None],0.,-32767.).astype(np.float32)
    assert valid.shape==(q,past+q)
    assert np.array_equal(valid,np.where(np.arange(past+q)[None,:]<=past+np.arange(q)[:,None],0.,-32767.).astype(np.float32))
    left=512-seq-past;mask[:q,left:left+past]=valid[:,:past]
    mask[:q,512-seq:512-seq+q]=valid[:,past:];mask[q:,0]=0.
    arrays=[hidden,cos,sin,mask,*keys,*values]
    refs=[data(count-1,'hidden_output')[0,row_start:row_start+q].copy(),*native_keys,*native_values]
    metadata=dict(image_id=image,call=call,query_rows=q,past_length=past,
                  source_query_rows=available,source_row_start=row_start,
                  native_history_only=True,chunked_full_model_verified=False)
    return arrays,refs,metadata


def main():
    p=argparse.ArgumentParser();p.add_argument('--target',type=Path,required=True);p.add_argument('--compiler-status-sha256',required=True)
    p.add_argument('--name',required=True);p.add_argument('--check-only',action='store_true');a=p.parse_args()
    assert a.name.replace('-','').isalnum() and len(a.name)<90
    root=a.target.resolve();assert root.parent==Path('/opt/locate-oellm-research-v1') and root.name.startswith('compact-affine-')
    out=Path('/opt')/('locate-profile-proof-'+a.name);archive=Path('/work/official-llm-v1')/(a.name+'.tar')
    report=Path('/work/official-llm-v1')/(a.name+'-package-report.json')
    assert not out.exists() and not archive.exists() and not report.exists()
    r=dict(status='checking',started=time.time(),source_sha256=sha(__file__),target=str(root),
      compiler_status_sha256=a.compiler_status_sha256,check_only=a.check_only,board_calls=0,
      whole_model_verified=False,release_approved=False)
    try:
        assert sha(root/'status.json')==a.compiler_status_sha256
        state=json.loads((root/'status.json').read_text())
        assert state['status']=='completed' and state['bpu_only']
        verify_compiler_origin(state)
        count=state['layer_count'];start=state['start_layer'];end=state['end_layer'];seq=state['sequence_capacity']
        assert count in [1,2,9] and end==start+count-1 and 0<=start<=end<36 and seq in [1,12,256]
        assert state['selected_checkpoint_sha256']==CHECKPOINT_SHA and not state['fresh_final_used']
        assert len(state['selected_modules'])==count*7 and all(m['bits']==4 and m['group_size']==32 and m['approximate_int8_branches']==0 for m in state['selected_modules'])
        assert sha(root/'stack.hbm')==state['hbm_sha256'] and sha(root/'stack-converted.bc')==state['converted_bc_sha256']
        graphs=json.loads((root/'disas.json').read_text())['graphs'];assert len(graphs)==1
        assert graphs[0]['nodes'] and all(n['device']=='DEVICE_CATEGORY_BPU' for n in graphs[0]['nodes'])
        r.update(layer_indices=list(range(start,end+1)),sequence=seq,hbm_sha256=state['hbm_sha256'],hbm_bytes=(root/'stack.hbm').stat().st_size)
        if a.check_only:r['status']='completed_component_integrity_checked'
        else:
            function=load(str(root/'stack-converted.bc')).functions[0]
            shapes=[(seq,2048),(seq,128),(seq,128),(seq,512)]+[(2,512,128)]*(count*2)
            outputs=[(seq,2048)]+[(2,seq,128)]*(count*2)
            assert [tuple(x.type.shape) for x in function.inputs]==shapes and [tuple(x.type.shape) for x in function.outputs]==outputs
            assert all(np.dtype(x.type.np_dtype)==np.float32 for x in [*function.inputs,*function.outputs])
            out.mkdir();fixtures=out/'fixtures';fixtures.mkdir();cases=[]
            config=json.loads(Path('/model/config.json').read_text())['text_config']
            for image in [1144,2444]:
                for call in ([0,1] if seq==1 else [0]):
                    source=Path('/work/all-decoder-layer-captures-v1')/f'gptq-bf16-{image}-slow'/f'block{start}-call-{call}'/'hidden_states.npy'
                    available=np.load(source,allow_pickle=False).shape[1]
                    offsets=[0,60,((available-1)//12)*12] if seq==12 else [0]
                    if seq==12:assert available>72 and len(set(offsets))==3
                    for row_start in offsets:
                        arrays,refs,case=fixture_arrays(start,end,seq,image,call,row_start,config)
                        q=case['query_rows']
                        actual=[np.asarray(x).copy() for x in function(*arrays)]
                        assert len(actual)==len(refs)==1+2*count
                        directory=fixtures/f'case-{len(cases):02d}';directory.mkdir()
                        case.update(inputs=[],outputs=[],compiler_vs_original_bf16=[])
                        for kind,entries,ports in [('input',arrays,function.inputs),('compiler',actual,function.outputs)]:
                            for i,(array,port) in enumerate(zip(entries,ports)):
                                assert array.dtype==np.float32 and np.isfinite(array).all()
                                path=directory/f'{kind}-{i:02d}.npy';np.save(path,array)
                                case['inputs' if kind=='input' else 'outputs'].append(dict(name=port.name,file=path.relative_to(fixtures).as_posix(),sha256=sha(path),shape=list(array.shape),dtype=str(array.dtype)))
                        for i,(value,ref) in enumerate(zip(actual,refs)):
                            slice_value=value[:q] if i==0 else value[:,:q]
                            case['compiler_vs_original_bf16'].append(dict(output=i,**metric(slice_value,ref)))
                        cases.append(case)
            fixture_report=dict(status='completed',cases=cases,reference='Isolated group with original native histories;not sequential compact-model box accuracy')
            (fixtures/'status.json').write_text(json.dumps(fixture_report,indent=2)+'\n')
            for src,dst in [('stack.hbm','model.hbm'),('status.json','compiler-status.json'),('disas.json','disas.json')]:shutil.copyfile(root/src,out/dst)
            files={p.relative_to(out).as_posix():sha(p) for p in sorted(out.rglob('*')) if p.is_file()}
            manifest=dict(schema='compact_affine_profile_fixture_v3',layer_indices=list(range(start,end+1)),sequence=seq,
              compiler_status_sha256=a.compiler_status_sha256,files=files,evaluation_only=True,release_approved=False,whole_model_verified=False,source_sha256=sha(__file__))
            (out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
            with tarfile.open(archive,'w') as tf:
                for path in sorted(out.rglob('*')):
                    if path.is_file():tf.add(path,arcname=path.relative_to(out).as_posix())
            r.update(status='completed',archive_sha256=sha(archive),archive_bytes=archive.stat().st_size,
              manifest_sha256=sha(out/'manifest.json'),cases=len(cases),maximum_hidden_relative_l2=max(c['compiler_vs_original_bf16'][0]['relative_l2'] for c in cases))
    except BaseException:r.update(status='failed',error=traceback.format_exc());raise
    finally:
        assert not torch.cuda.is_initialized();r['finished']=time.time();report.write_text(json.dumps(r,indent=2)+'\n')
    print(json.dumps(r))

if __name__=='__main__':main()
