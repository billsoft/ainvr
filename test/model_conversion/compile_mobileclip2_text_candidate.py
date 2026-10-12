"""AINVR isolated encoder HBM candidate; no deployment or accuracy approval."""
import argparse,hashlib,json,logging,os,time
from pathlib import Path
import numpy as np
import onnx
from hmct.ir import OnnxModel
from hmct.builder.model_builder import ModelBuilder
from hbdk4.compiler.onnx import export
from hbdk4.compiler import convert,compile,save as save_bc

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--model',type=Path,required=True)
p.add_argument('--calibration',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();a.output.mkdir(exist_ok=False);logging.basicConfig(level=logging.INFO)
allowed=sorted(os.sched_getaffinity(0));os.sched_setaffinity(0,set(allowed[:4]))
digest=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert digest(a.model)=='b271149eddb7bd8a3649a5a6330cf394d53f933b4f7e36c963331400c26bfb14'
r={'state':'preparing','started_unix':time.time(),'source_onnx_sha256':digest(a.model),
   'target':'nash-m','production_approved':False,'accuracy_verified':False,
   'scope':'MobileCLIP2 text encoder before YOLOE RepRTA; candidate only'}
def save(): (a.output/'status.json').write_text(json.dumps(r,indent=2))
save()
try:
    graph=onnx.load(str(a.model));repaired=[]
    for n in graph.graph.node:
        if n.op_type!='Constant':continue
        for attr in n.attribute:
            if attr.type!=onnx.AttributeProto.TENSOR:continue
            arr=onnx.numpy_helper.to_array(attr.t)
            if not np.issubdtype(arr.dtype,np.floating):continue
            assert not np.isnan(arr).any() and not np.isposinf(arr).any()
            if np.isneginf(arr).any():
                assert arr.shape in [(77,77),(1,1,77,77)]
                values=arr.copy();values[np.isneginf(values)]=-10000
                attr.t.CopyFrom(onnx.numpy_helper.from_array(values));repaired.append(n.name)
    r['causal_mask_finite_repair_nodes']=repaired
    # Independently verify finite-mask repair on the four held-out word tokens.
    import onnxruntime as ort
    opts=ort.SessionOptions();opts.intra_op_num_threads=2;opts.inter_op_num_threads=1
    original=ort.InferenceSession(str(a.model),opts,providers=['CPUExecutionProvider'])
    fixed=ort.InferenceSession(graph.SerializeToString(),opts,providers=['CPUExecutionProvider'])
    errors=[]
    samples=a.model.parent.parent/'real-text-check-v4'
    for sample in sorted(samples.glob('prompts-*.npz')):
        for tokens in np.load(sample)['tokens']:
            feed={'tokens':np.ascontiguousarray(tokens.reshape(1,77),dtype=np.int64)}
            x=original.run(None,feed)[0];y=fixed.run(None,feed)[0]
            assert np.isfinite(y).all();error=float(np.max(np.abs(x-y)));assert error<1e-6;errors.append(error)
    assert len(errors)==4;r['finite_mask_reference_max_error']=max(errors)
    del original,fixed
    onnx.save(graph,a.output/'finite-original.onnx')
    files=sorted(a.calibration.glob('*.npy'));assert len(files)==512
    data=[]
    for path in files:
        tokens=np.load(path);assert tokens.dtype==np.int64 and tokens.shape==(1,77)
        assert tokens.min()>=0 and tokens.max()<=49407;data.append(tokens)
    r.update(state='quantizing',calibration_samples=512,calibration_manifest_sha256=digest(a.calibration/'manifest.json'));save()
    b=ModelBuilder(OnnxModel(graph),'nash-m',save_model=True,verbose=False,
        name_prefix=str(a.output/'text'),cali_dict={'calibration_data':{'tokens':data}},
        user_quant_config={'model_config':{'all_node_type':'int16','activation':{'calibration_type':'max'}}})
    ptq=b.build();assert ptq is not None;onnx.save(ptq,a.output/'ptq.onnx')
    r['state']='converting';save();m=export(proto=ptq,name='mobileclip2_text')
    m=convert(m,march='nash-m',advice=True,advice_path=str(a.output)+'/')
    ops=json.loads((a.output/'mobileclip2_text_advice.json').read_text());cpu=[x for x in ops if x['backend']=='external_cpu']
    # The only allowed host operations are exact token-ID EOT selection logic,
    # never embedding lookup, LayerNorm, attention or feature arithmetic.
    rejected=[x for x in cpu if x['op_name'] not in ['/ArgMax','exact_token_cast_for_eot']]
    r.update(external_cpu_ops=cpu,cpu_neural_fallback_rejected_ops=rejected);save()
    assert ops and not rejected,'Text neural CPU fallback rejected; do not deploy'
    save_bc(m,str(a.output/'quantized.bc'));r.update(state='compiling',bc_sha256=digest(a.output/'quantized.bc'));save()
    compile(m,str(a.output/'mobileclip2-text.hbm'),march='nash-m',opt=0,jobs=1,debug=False,progress_bar=True)
    r.update(state='compiled_needs_validation',hbm_sha256=digest(a.output/'mobileclip2-text.hbm'))
except BaseException as e:r.update(state='failed',error=repr(e));raise
finally:r['finished_unix']=time.time();save()
print(json.dumps(r,indent=2),flush=True)
