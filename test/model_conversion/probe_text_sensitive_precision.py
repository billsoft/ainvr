"""AINVR reuse text calibration, diagnose sensitive precision before compilation.

All variants retain original integer linear weights. Floating sensitive layers
must pass both the fixed independent-text gate and no-neural-CPU placement gate.
This is not approval for the complete YOLOE pipeline.
"""
import argparse,hashlib,json,time
from pathlib import Path
import numpy as np
import onnx
import onnxruntime as ort
from hmct.ir import OnnxModel,CalibrationNode
from hmct.builder.model_builder import ModelBuilder
from hmct.executor.ort2 import get_operators_path
from onnxruntime_extensions import get_library_path
from hbdk4.compiler.onnx import export
from hbdk4.compiler import convert,compile,save as save_bc
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--candidate',type=Path,required=True)
p.add_argument('--references',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--jobs',type=int,default=4)
p.add_argument('--sensitive-dtype',choices=['float32','float16','mixed'],default='float32')
p.add_argument('--explicit-fp16-center',action='store_true')
p.add_argument('--fp32-center-via-add',action='store_true')
p.add_argument('--variant',choices=['float_layernorm','float_layernorm_softmax','float_sensitive_activations'])
p.add_argument('--attention-float-mask',action='store_true')
p.add_argument('--bounded-integer-softmax',action='store_true')
p.add_argument('--attention-input-ec',action='store_true')
p.add_argument('--final-float-norm',action='store_true')
p.add_argument('--linear-weight-ec',action='store_true')
p.add_argument('--float-softmax-tail',action='store_true')
a=p.parse_args();a.output.mkdir(exist_ok=False);assert 1<=a.jobs<=4
s=json.loads((a.candidate/'status.json').read_text());assert s['hbm_sha256']=='3c743e8e215cd3058490a9b980cffe336f332e8d23c1fc245491b2167bb6d03f'
refs=json.loads((a.references/'manifest.json').read_text());assert len(refs['samples'])==128 and refs['calibration_overlap']==0
r={'state':'diagnosing','started_unix':time.time(),'production_approved':False,
   'accuracy_verified':False,'opt':0,'jobs':a.jobs,'target':'nash-m',
   'scope':'Encoder only; no RepRTA or full YOLOE detector','calibration_repeated':False,
   'failed_baseline_hbm_sha256':s['hbm_sha256'],'sensitive_dtype':a.sensitive_dtype,
   'explicit_fp16_center':a.explicit_fp16_center,'fp32_center_via_add':a.fp32_center_via_add,
   'attention_float_mask':a.attention_float_mask,'requested_variant':a.variant,
   'bounded_integer_softmax':a.bounded_integer_softmax,
   'attention_input_ec':a.attention_input_ec,'final_float_norm':a.final_float_norm,
   'linear_weight_ec':a.linear_weight_ec,
   'float_softmax_tail':a.float_softmax_tail,
   'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'variants':[]}
assert not (a.explicit_fp16_center and a.fp32_center_via_add)
assert not a.attention_float_mask or (a.sensitive_dtype=='float32' and a.variant=='float_layernorm_softmax' and a.fp32_center_via_add)
assert not a.bounded_integer_softmax or a.attention_float_mask
assert not a.attention_input_ec or a.bounded_integer_softmax
assert not a.float_softmax_tail or a.bounded_integer_softmax
def save():(a.output/'status.json').write_text(json.dumps(r,indent=2))
save();opts=ort.SessionOptions();opts.intra_op_num_threads=2;opts.inter_op_num_threads=1;opts.log_severity_level=3
opts.register_custom_ops_library(get_operators_path());opts.register_custom_ops_library(get_library_path())
def fp16_center(proto):
    rebuilt=[];count=0
    for node in proto.graph.node:
        if node.op_type=='Sub' and 'LayerNormalization' in node.name and node.name.endswith('_sub1'):
            assert len(node.input)==2 and len(node.output)==1
            count+=1;names=[node.name+'_input_fp16',node.name+'_mean_fp16']
            for input_name,name in zip(node.input,names):
                rebuilt.append(onnx.helper.make_node('Cast',[input_name],[name],name=name,to=onnx.TensorProto.FLOAT16))
            out=node.output[0];half=node.name+'_center_fp16'
            rebuilt.append(onnx.helper.make_node('Sub',names,[half],name=node.name))
            rebuilt.append(onnx.helper.make_node('Cast',[half],[out],name=node.name+'_center_fp32',to=onnx.TensorProto.FLOAT))
        else:rebuilt.append(node)
    assert count==25,('Expected 25 exact LayerNorm centering operations',count)
    del proto.graph.node[:];proto.graph.node.extend(rebuilt)
    return proto
def fp32_center_via_add(proto):
    name='ainvr_ln_center_negative_one'
    assert not any(x.name==name for x in proto.graph.initializer)
    proto.graph.initializer.append(onnx.numpy_helper.from_array(np.array(-1,dtype=np.float32),name))
    rebuilt=[];count=0;softmax_count=0
    for node in proto.graph.node:
        layernorm='LayerNormalization' in node.name and node.name.endswith('_sub1')
        softmax=a.attention_float_mask and 'Softmax' in node.name and node.name.endswith('_sub_FROM_QUANTIZED_SOFTMAX')
        if node.op_type=='Sub' and (layernorm or softmax):
            assert len(node.input)==2 and len(node.output)==1
            if layernorm:count+=1
            if softmax:softmax_count+=1
            negative=node.name+'_negative_mean'
            rebuilt.append(onnx.helper.make_node('Mul',[node.input[1],name],[negative],name=node.name+'_negate_mean'))
            rebuilt.append(onnx.helper.make_node('Add',[node.input[0],negative],list(node.output),name=node.name))
        else:rebuilt.append(node)
    assert count==25
    if a.attention_float_mask:assert softmax_count==12,softmax_count
    del proto.graph.node[:];proto.graph.node.extend(rebuilt)
    return proto
try:
    selected=None
    for variant in ([a.variant] if a.variant else ['float_layernorm','float_layernorm_softmax','float_sensitive_activations']):
        destination=a.output/variant;destination.mkdir()
        model=OnnxModel(str(a.candidate/'calibrated-split.onnx'));changes=[]
        mask_nodes=set()
        if a.attention_float_mask:
            # The causal mask is -10000. Quantizing it jointly with ordinary
            # attention scores loses small score differences before Softmax.
            # Preserve both Add inputs and its output, using original statistics.
            for node in model.graph.nodes:
                if node.op_type!='ReduceMax' or 'Softmax' not in node.name or not node.name.endswith('_reducemax_FROM_QUANTIZED_SOFTMAX'):continue
                calibration=node.inputs[0].src_op
                assert isinstance(calibration,CalibrationNode)
                add=calibration.inputs[0].src_op;assert add.op_type=='Add'
                mask_nodes.add(calibration.name)
                for value in add.inputs:
                    parent=value.src_op;assert isinstance(parent,CalibrationNode)
                    mask_nodes.add(parent.name)
            assert len(mask_nodes)==36,len(mask_nodes)
        for node in model.graph.nodes:
            if not isinstance(node,CalibrationNode):continue
            name=node.name
            change=('LayerNormalization' in name)
            if variant!='float_layernorm':change |= 'Softmax' in name
            if variant=='float_sensitive_activations':change |= 'Gelu' in name or 'gelu' in name or 'ReduceL2' in name
            change |= name in mask_nodes
            final_norm=a.final_float_norm and name.startswith(('/ReduceL2','/Div_24','/MatMul_72_output_0','text_embedding'))
            change |= final_norm
            if change:
                changes.append({'node':name,'old_qtype':node.qtype})
                dtype=a.sensitive_dtype
                if dtype=='mixed':
                    dtype='float16' if ('LayerNormalization' in name and ('_mean1_' in name or '_sub1_' in name)) else 'float32'
                if a.bounded_integer_softmax and 'Softmax' in name and '_max_' not in name:
                    dtype='int16'
                    # Attention masks reach -10000, but Exp(-16) is already
                    # negligible. A fixed centered-logit range retains useful
                    # differences and permits native integer Exp/MatMul kernels.
                    if name.endswith('_sub_HzCalibration'):node.thresholds=np.array([16.],dtype=np.float32)
                if a.float_softmax_tail and 'Softmax' in name and ('_reducesum_' in name or '_reciprocal_' in name):
                    # Integer Exp is required by this compiler, but its sum
                    # and inverse can be kept floating before the final
                    # probability tensor is packed for integer MatMul.
                    dtype='float32'
                node.qtype=dtype;node.switch='OFF' if dtype=='float32' else 'ON'
        original=OnnxModel(str(a.candidate/'original-split.onnx'))
        if a.explicit_fp16_center:
            assert a.sensitive_dtype=='float32'
            model=OnnxModel(fp16_center(model.proto))
            # The optimizer's FP32 reference still has fused LayerNormalization.
            # Keep it as the unchanged reference/target initializer; centering
            # nodes exist only in the calibrated decomposition. Explicit casts
            # are an intended rounding change, checked against the FP32 oracle.
        if a.fp32_center_via_add:
            assert a.sensitive_dtype=='float32'
            model=OnnxModel(fp32_center_via_add(model.proto))
        if a.attention_input_ec:
            from hmct.common import QuantConfig
            from hmct.quantizer.calibrater.activation.compensate_activation import CompensateActivation
            names=[node.name for node in model.graph.nodes if node.op_type=='MatMul' and
                   isinstance(node.inputs[1].src_op,CalibrationNode) and node.inputs[1].src_op.qtype=='int8']
            assert len(names)==24,names
            config=QuantConfig('nash-m')
            config.load_user_quant_config({'node_config':{name:{'input0':'int16','input1':'ec','output':'int16'} for name in names}})
            count=CompensateActivation(config)(model);assert count==24,count
            r.update(compensated_dynamic_matmuls=names,activation_error_compensation_pass_changes=count);save()
        if a.linear_weight_ec:
            from hmct.common import QuantConfig
            from hmct.quantizer.calibrater.weight.compensate_weight import CompensateWeight
            names=[node.name for node in model.graph.nodes if node.op_type=='Conv']
            # Q/K/V are packed into one learned projection per block: four
            # linear operators x 12 blocks, plus the final text projection.
            assert len(names)==49,names
            config=QuantConfig('nash-m')
            config.load_user_quant_config({'node_config':{name:{'input0':'int16','input1':'ec','output':'int16'} for name in names}})
            count=CompensateWeight(config)(model);assert count==49,count
            r.update(compensated_linear_weights=names,weight_error_compensation_pass_changes=count);save()
        model.infer_shapes().check_validity();original.infer_shapes().check_validity()
        builder=ModelBuilder(original,'nash-m',save_model=False,verbose=False);builder.original_model=original
        quantized=builder.quantize(model);quantized.infer_shapes().check_validity()
        onnx.save(quantized.proto,destination/'ptq.onnx')
        sess=ort.InferenceSession(quantized.proto.SerializeToString(),opts,providers=['CPUExecutionProvider'])
        rows=[];passed=True
        for i,item in enumerate(refs['samples']):
            data=np.load(a.references/item['file']);ref=data['reference'].astype(np.float64)
            got=sess.run(None,{'tokens':data['tokens']})[0].astype(np.float64)
            assert got.shape==ref.shape and np.isfinite(got).all()
            cosine=float(np.dot(got.ravel(),ref.ravel())/(np.linalg.norm(got)*np.linalg.norm(ref)))
            relative_l2=float(np.linalg.norm(got-ref)/np.linalg.norm(ref))
            rows.append({'phrase':item['phrase'],'cosine':cosine,'relative_l2':relative_l2})
            if cosine<.995 or relative_l2>.1:passed=False
            # Failed candidates are retained; avoid simulating 128 known-bad texts.
            if i==3 and not passed:break
        audit={'variant':variant,'changed_nodes':changes,'samples':len(rows),'passed':passed,
               'min_cosine':min(x['cosine'] for x in rows),'max_relative_l2':max(x['relative_l2'] for x in rows),'rows':rows}
        (destination/'offline-parity.json').write_text(json.dumps(audit,indent=2))
        r['variants'].append({k:v for k,v in audit.items() if k not in ['rows','changed_nodes']});save()
        print(json.dumps(r['variants'][-1]),flush=True)
        del sess,builder,model,original
        if passed and len(rows)==128:
            selected=(variant,quantized);break
        del quantized
    assert selected is not None,'All precision candidates failed the unchanged independent-text gate'
    variant,quantized=selected;r.update(state='converting',selected_variant=variant);save()
    module=export(proto=quantized.proto,name='mobileclip2_sensitive_precision')
    module=convert(module,march='nash-m',advice=True,advice_path=str(a.output)+'/')
    ops=json.loads((a.output/'mobileclip2_sensitive_precision_advice.json').read_text())
    cpu=[x for x in ops if x['backend']=='external_cpu']
    allowed={'token_low_index','token_hi_offset','token_high_index','exact_token_cast_for_eot','/ArgMax'}
    rejected=[x for x in cpu if x['op_name'] not in allowed]
    r.update(external_cpu_ops=cpu,cpu_neural_fallback_rejected_ops=rejected);save()
    assert not rejected,'Neural CPU fallback rejected'
    save_bc(module,str(a.output/'quantized.bc'))
    r.update(state='compiling',bc_sha256=hashlib.sha256((a.output/'quantized.bc').read_bytes()).hexdigest());save()
    compile(module,str(a.output/'mobileclip2-text.hbm'),march='nash-m',opt=0,jobs=a.jobs,debug=False,
            progress_bar=True,cache_mode='enable',cache_path=str(a.output/'compiler-cache'))
    r.update(state='compiled_needs_validation',hbm_sha256=hashlib.sha256((a.output/'mobileclip2-text.hbm').read_bytes()).hexdigest())
except BaseException as e:r.update(state='failed',error=repr(e));raise
finally:r['finished_unix']=time.time();save()
