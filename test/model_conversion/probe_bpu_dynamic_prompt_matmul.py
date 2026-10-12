"""AINVR isolated two-runtime-input BPU MatMul functionality probe.

Synthetic tensors validate an interface and arithmetic, not YOLOE accuracy.
Never approve or install this small probe as a production detector.
"""
import argparse
from pathlib import Path
import json, time, hashlib
import numpy as np
import onnx
from onnx import helper, TensorProto
from hmct.ir import OnnxModel
from hmct.builder.model_builder import ModelBuilder
from hbdk4.compiler import convert, compile, save as save_bc
from hbdk4.compiler.onnx import export

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();a.output.mkdir(exist_ok=False)
r={'state':'starting','started_unix':time.time(),'target':'nash-m',
   'scope':'Two runtime tensors and integer MatMul only, not full YOLOE',
   'production_approved':False,'semantic_accuracy_verified':False}
def save(): (a.output/'status.json').write_text(json.dumps(r,indent=2))
save()
try:
    shapes={'prompt_embeddings':[1,8,512],'region_features':[1,512,400]}
    graph=helper.make_graph([helper.make_node('MatMul',['prompt_embeddings','region_features'],['scores'],name='runtime_prompt_match')],'runtime_prompt_probe',[helper.make_tensor_value_info(n,TensorProto.FLOAT,s) for n,s in shapes.items()],[helper.make_tensor_value_info('scores',TensorProto.FLOAT,[1,8,400])])
    model=helper.make_model(graph,opset_imports=[helper.make_opsetid('',17)]); model.ir_version=8;onnx.checker.check_model(model);onnx.save(model,a.output/'original.onnx')
    gen=np.random.default_rng(26);data={n:[] for n in shapes}
    for i in range(32):
        prompt=gen.normal(size=shapes['prompt_embeddings']).astype('float32');prompt/=np.linalg.norm(prompt,axis=-1,keepdims=True)
        feature=gen.normal(size=shapes['region_features']).astype('float32')*.25
        data['prompt_embeddings'].append(prompt);data['region_features'].append(feature)
    b=ModelBuilder(OnnxModel(model),'nash-m',save_model=False,verbose=False,
        cali_dict={'calibration_data':data},user_quant_config={'model_config':{'all_node_type':'int16','activation':{'calibration_type':'max'}}})
    r['state']='quantizing';save();ptq=b.build();assert ptq is not None;onnx.save(ptq,a.output/'ptq.onnx')
    m=export(proto=ptq,name='runtime_prompt_probe');m=convert(m,march='nash-m',advice=True,advice_path=str(a.output)+'/')
    advice=json.loads((a.output/'runtime_prompt_probe_advice.json').read_text())
    r['placement']=[{k:x.get(k) for k in ['op_name','op_type','backend','input_types']} for x in advice];save()
    assert advice and all(x['backend']=='bpu' for x in advice),'Neural CPU fallback rejected'
    save_bc(m,str(a.output/'quantized.bc'));r['state']='compiling';save()
    compile(m,str(a.output/'probe.hbm'),march='nash-m',opt=0,jobs=1,debug=False,progress_bar=True)
    # Same image-region features, two independently changed runtime prompts.
    for n in ['a','b']:
        prompt=gen.normal(size=shapes['prompt_embeddings']).astype('float32');prompt/=np.linalg.norm(prompt,axis=-1,keepdims=True)
        np.savez(a.output/(n+'.npz'),prompt_embeddings=prompt,region_features=feature,reference=prompt@feature)
    r.update(state='compiled_needs_board_validation',hbm_sha256=hashlib.sha256((a.output/'probe.hbm').read_bytes()).hexdigest(),inputs=shapes,calibration_samples=32,calibration_scope='Synthetic bounded operator probe only')
except Exception as e:
    r.update(state='failed',error=repr(e));raise
finally:
    r['finished_unix']=time.time();save()
print(json.dumps(r,indent=2),flush=True)
