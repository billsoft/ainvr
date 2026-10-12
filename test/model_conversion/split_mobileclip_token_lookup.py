"""AINVR equivalent split token lookup and reuse of saved text calibration.

No production approval; real HBM output comparison remains required. Token
indices are int32, range 0..49407, and EOT ArgMax stays exact floating index logic.
"""
import argparse,copy,hashlib,json,time
from pathlib import Path
import numpy as np
import onnx
from onnx import helper,numpy_helper,TensorProto
from hmct.ir import OnnxModel,CalibrationNode
from hmct.builder.model_builder import ModelBuilder
from hbdk4.compiler.onnx import export
from hbdk4.compiler import convert,compile,save as save_bc
import onnxruntime as ort
from hmct.executor.ort2 import get_operators_path
from onnxruntime_extensions import get_library_path

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--saved',type=Path,required=True)
p.add_argument('--samples',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--jobs',type=int,default=4)
a=p.parse_args();assert 1<=a.jobs<=8;a.output.mkdir(exist_ok=False)
sha=lambda f:hashlib.sha256(f.read_bytes()).hexdigest()
r={'state':'rewriting','started_unix':time.time(),'production_approved':False,'accuracy_verified':False,
   'calibration_repeated':False,'target':'nash-m','jobs':a.jobs,'opt':0,
   'scope':'Text encoder token lookup split; does not include RepRTA or full YOLOE detector'}
def save(): (a.output/'status.json').write_text(json.dumps(r,indent=2))
save()
def rewrite(proto,calibrated):
    g=proto.graph;old=next(n for n in g.node if n.name=='/Gather');table_name=old.input[0]
    cal=None
    if calibrated:
        cal=next(n for n in g.node if list(n.output)==[table_name]);assert cal.op_type=='HzCalibration';table_name=cal.input[0]
    source=next(x for x in g.initializer if x.name==table_name);table=numpy_helper.to_array(source)
    assert table.shape==(49408,512) and table.dtype==np.float32
    name='split_token_table';g.initializer.extend([numpy_helper.from_array(table[:32768].copy(),name+'_low'),numpy_helper.from_array(table[32768:].copy(),name+'_high')])
    low,high=name+'_low',name+'_high';nodes=[]
    if cal:
        for tag in ['low','high']:
            c=copy.deepcopy(cal);c.name=cal.name+'_'+tag;c.input[0]=name+'_'+tag;c.output[0]=name+'_'+tag+'_calibrated';nodes.append(c)
        low+='_calibrated';high+='_calibrated'
    for name_,value in [('partition',32768),('low_max',32767),('zero',0)]:
        g.initializer.append(numpy_helper.from_array(np.array(value,dtype=np.int32),'token_'+name_))
    g.initializer.append(numpy_helper.from_array(np.array([2],dtype=np.int64),'token_mask_axes'))
    nodes.extend([
        helper.make_node('Min',['tokens','token_low_max'],['token_low_safe'],name='token_low_index'),
        helper.make_node('Sub',['tokens','token_partition'],['token_high_offset'],name='token_hi_offset'),
        helper.make_node('Max',['token_high_offset','token_zero'],['token_high_safe'],name='token_high_index'),
        helper.make_node('Less',['tokens','token_partition'],['token_low_mask'],name='token_partition'),
        helper.make_node('Unsqueeze',['token_low_mask','token_mask_axes'],['token_low_mask3'],name='token_partition_expand'),
        helper.make_node('Gather',[low,'token_low_safe'],['token_low_embedding'],name='token_low_lookup',axis=0),
        helper.make_node('Gather',[high,'token_high_safe'],['token_high_embedding'],name='token_high_lookup',axis=0),
        helper.make_node('Where',['token_low_mask3','token_low_embedding','token_high_embedding'],list(old.output),name='token_partition_select')])
    rebuilt=[]
    for n in g.node:
        if cal is not None and n.name==cal.name:continue
        if n.name==old.name:rebuilt.extend(nodes)
        else:rebuilt.append(n)
    del g.node[:];g.node.extend(rebuilt)
    retained=[x for x in g.initializer if x.name!=table_name];del g.initializer[:];g.initializer.extend(retained)
    assert len(g.input)==1 and g.input[0].name=='tokens';g.input[0].type.tensor_type.elem_type=TensorProto.INT32
    for x in g.value_info:
        if x.name=='tokens':x.type.tensor_type.elem_type=TensorProto.INT32
    return proto,table
try:
    original_path=a.saved/'text_optimized_float_model.onnx';cal_path=a.saved/'text_calibrated_model.onnx'
    assert sha(original_path)=='7c37d66d7c305757d3a2c1cbd6b52ae2c8e814b06568fbdce0be1b7c6a2cbda5'
    assert sha(cal_path)=='852d358bcd37643af8b4ae48d3a226a6cd3e8d92651585d475b78c634cb4c8cc'
    r.update(original_sha256=sha(original_path),calibrated_sha256=sha(cal_path));save()
    original=onnx.load(str(original_path));changed,table=rewrite(copy.deepcopy(original),False)
    opts=ort.SessionOptions();opts.intra_op_num_threads=2;opts.inter_op_num_threads=1
    opts.register_custom_ops_library(get_operators_path())
    opts.register_custom_ops_library(get_library_path())
    before=ort.InferenceSession(original.SerializeToString(),opts,providers=['CPUExecutionProvider'])
    after=ort.InferenceSession(changed.SerializeToString(),opts,providers=['CPUExecutionProvider'])
    errors=[]
    for sample in sorted(a.samples.glob('prompts-*.npz')):
        for t in np.load(sample)['tokens']:
            t=t.reshape(1,77);x=before.run(None,{'tokens':t.astype(np.int64)})[0];y=after.run(None,{'tokens':t.astype(np.int32)})[0]
            error=float(np.max(np.abs(x-y)));assert error<1e-6;errors.append(error)
    assert len(errors)==4
    ids=np.array([0,1,32766,32767,32768,32769,49406,49407],dtype=np.int32)
    expected=table[ids];got=np.where((ids<32768)[:,None],table[:32768][np.minimum(ids,32767)],table[32768:][np.maximum(ids-32768,0)])
    assert np.array_equal(expected,got)
    r.update(fp32_rewrite_max_error=max(errors),lookup_boundary_values_verified=ids.tolist());save()
    del before,after,table,original
    onnx.save(changed,a.output/'original-split.onnx')
    calibrated,_=rewrite(onnx.load(str(cal_path)),True);model=OnnxModel(calibrated)
    eot=model.graph.node_mappings['tokens_exact_fp32_for_eot_HzCalibration'];assert isinstance(eot,CalibrationNode)
    eot.qtype='float32';eot.switch='OFF'
    model.infer_shapes().check_validity();onnx.save(model.proto,a.output/'calibrated-split.onnx')
    builder=ModelBuilder(OnnxModel(changed),'nash-m',save_model=False,verbose=False);builder.original_model=OnnxModel(changed)
    r['state']='requantizing';save();quantized=builder.quantize(model);quantized.infer_shapes().check_validity();onnx.save(quantized.proto,a.output/'ptq.onnx')
    r['state']='converting';save();m=export(proto=quantized.proto,name='mobileclip2_split_lookup')
    m=convert(m,march='nash-m',advice=True,advice_path=str(a.output)+'/')
    ops=json.loads((a.output/'mobileclip2_split_lookup_advice.json').read_text());cpu=[x for x in ops if x['backend']=='external_cpu']
    index_ops={'/ArgMax','exact_token_cast_for_eot','token_low_index','token_hi_offset','token_high_index','token_partition','token_partition_expand'}
    rejected=[x for x in cpu if x['op_name'] not in index_ops];r.update(external_cpu_ops=cpu,cpu_neural_fallback_rejected_ops=rejected);save()
    assert ops and not rejected,'Neural CPU fallback rejected'
    save_bc(m,str(a.output/'quantized.bc'));r.update(state='compiling',bc_sha256=sha(a.output/'quantized.bc'));save()
    compile(m,str(a.output/'mobileclip2-text.hbm'),march='nash-m',opt=0,jobs=a.jobs,debug=False,progress_bar=True,cache_mode='enable',cache_path=str(a.output/'compiler-cache'))
    r.update(state='compiled_needs_validation',hbm_sha256=sha(a.output/'mobileclip2-text.hbm'))
except BaseException as e:r.update(state='failed',error=repr(e));raise
finally:r['finished_unix']=time.time();save()
print(json.dumps(r,indent=2),flush=True)
