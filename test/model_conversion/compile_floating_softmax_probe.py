"""AINVR FP32 fused Softmax operator probe; not a full model or calibration."""
import argparse,json,time,hashlib
from pathlib import Path
import numpy as np
import onnx
from hbdk4.compiler.onnx import export
from hbdk4.compiler import convert,compile,save as save_bc
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();a.output.mkdir(exist_ok=False)
state={'state':'preparing','scope':'FP32 fused Softmax only; no full YOLOE approval',
       'production_approved':False,'started_unix':time.time(),'target':'nash-m'}
def save():(a.output/'status.json').write_text(json.dumps(state,indent=2))
try:
    shape=[1,8,77,77]
    graph=onnx.helper.make_graph([onnx.helper.make_node('Softmax',['logits'],['probabilities'],name='fused_float_softmax',axis=-1)],'probe',
        [onnx.helper.make_tensor_value_info('logits',onnx.TensorProto.FLOAT,shape)],
        [onnx.helper.make_tensor_value_info('probabilities',onnx.TensorProto.FLOAT,shape)])
    model=onnx.helper.make_model(graph,opset_imports=[onnx.helper.make_opsetid('',17)]);model.ir_version=9
    onnx.checker.check_model(model);onnx.save(model,a.output/'softmax.onnx')
    rng=np.random.default_rng(20261013);inputs=rng.normal(0,8,shape).astype(np.float32)
    inputs[:,:,np.triu_indices(77,1)[0],np.triu_indices(77,1)[1]]=-10000
    exponent=np.exp(inputs-inputs.max(axis=-1,keepdims=True));reference=exponent/exponent.sum(axis=-1,keepdims=True)
    np.savez_compressed(a.output/'reference.npz',input=inputs,reference=reference)
    state['state']='converting';save()
    module=convert(export(proto=model,name='fused_float_softmax'),march='nash-m',advice=True,advice_path=str(a.output)+'/')
    placement=json.loads((a.output/'fused_float_softmax_advice.json').read_text())
    cpu=[x for x in placement if x['backend']=='external_cpu'];state.update(external_cpu_ops=cpu,placement=placement);save()
    assert placement and not cpu,'FP32 fused Softmax CPU fallback rejected'
    save_bc(module,str(a.output/'quantized.bc'));state['state']='compiling';save()
    compile(module,str(a.output/'softmax.hbm'),march='nash-m',opt=0,jobs=1,debug=False,progress_bar=True)
    state.update(state='compiled_needs_validation',hbm_sha256=hashlib.sha256((a.output/'softmax.hbm').read_bytes()).hexdigest())
except BaseException as error:state.update(state='failed',error=repr(error));raise
finally:state['finished_unix']=time.time();save()
