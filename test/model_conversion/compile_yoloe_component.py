"""AINVR GPU-toolchain candidates for matching RepRTA or complete YOLOE.

No production approval. Preserve calibrated graphs/BC and reject every neural
CPU fallback. CUDA arena is bounded; compilation still uses CPU jobs where required.
"""
import argparse,hashlib,json,logging,time
from pathlib import Path
import numpy as np
import onnx
from hmct.ir import OnnxModel,CalibrationNode
from hmct.builder.model_builder import ModelBuilder
from hmct.executor.ort2 import ORTExecutor2
from hbdk4.compiler.onnx import export
from hbdk4.compiler import convert,compile,save as save_bc
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--kind',choices=['reprta','detector'],required=True)
p.add_argument('--prepared',type=Path,required=True)
p.add_argument('--research',type=Path,required=True)
p.add_argument('--images',type=Path)
p.add_argument('--output',type=Path,required=True)
p.add_argument('--jobs',type=int,default=4)
p.add_argument('--reuse-calibration',type=Path)
p.add_argument('--rewrite-float-clip',action='store_true')
p.add_argument('--detector-float-prompt-norm',action='store_true')
p.add_argument('--reprta-weight-ec',action='store_true')
p.add_argument('--reprta-activation-headroom',type=float,default=1.)
p.add_argument('--detector-matching-ec',action='store_true')
a=p.parse_args();a.output.mkdir(exist_ok=False);assert 1<=a.jobs<=4
assert not a.detector_float_prompt_norm or (a.kind=='detector' and a.reuse_calibration and a.rewrite_float_clip)
assert not a.reprta_weight_ec or (a.kind=='reprta' and a.reuse_calibration and a.rewrite_float_clip)
assert 1<=a.reprta_activation_headroom<=4
assert a.reprta_activation_headroom==1 or (a.kind=='reprta' and a.reuse_calibration)
assert not a.detector_matching_ec or (a.kind=='detector' and a.reuse_calibration and a.detector_float_prompt_norm)
logging.basicConfig(level=logging.INFO)
sha=lambda x:hashlib.sha256(x.read_bytes()).hexdigest()
prepared=json.loads((a.prepared/'manifest.json').read_text());assert prepared['state']=='prepared' and not prepared['production_approved']
# Pinned HMCT 2.6.5 defaults to CUDA then CPU in the GPU image. Restrict each
# CUDA arena so coexistence does not consume all the user's GPU memory.
assert ORTExecutor2.get_support_devices()[0]=='cuda'
original_cuda_provider=ORTExecutor2._cuda_provider
def bounded_cuda_provider(self,device_id=0):
    provider,options=original_cuda_provider(self,device_id)
    options.update(gpu_mem_limit=4*1024**3,arena_extend_strategy='kSameAsRequested',use_tf32=0)
    return provider,options
ORTExecutor2._cuda_provider=bounded_cuda_provider
r={'state':'preparing','kind':a.kind,'started_unix':time.time(),'target':'nash-m',
   'jobs':a.jobs,'opt':0,'production_approved':False,'accuracy_verified':False,
   'offline_gpu_calibration_requested':True,'cuda_arena_limit_gib_per_session':4,
   'prepared_manifest_sha256':sha(a.prepared/'manifest.json'),'calibration_repeated':False}
r['script_sha256']=sha(Path(__file__))
def save():(a.output/'status.json').write_text(json.dumps(r,indent=2))
save()
try:
    if a.kind=='reprta':
        source=a.prepared/'yoloe-reprta-8prompts.onnx'
        assert sha(source)==prepared['reprta_onnx_sha256']
        samples=sorted((a.prepared/'reprta-calibration').glob('*.npy'));assert len(samples)==64
        data={'text_embeddings':[np.load(x) for x in samples]}
        assert all(x.shape==(1,8,512) and x.dtype==np.float32 for x in data['text_embeddings'])
    else:
        assert a.images and prepared['calibration_images']==512
        source=a.research/'onnx-probe-v1/yoloe26x-runtime-8prompts.onnx'
        assert sha(source)==prepared['detector_onnx_sha256']=='951028bf70804f6c3c1a464bab9b522f6706d3a4c5efaeeeaa8c4b9f8073f5df'
        rows=[x for x in prepared['samples'] if x['split']=='calibration'];assert len(rows)==512
        data={'images':[],'prompt_embeddings':[]}
        for row in ([] if a.reuse_calibration else rows):
            image=a.images/row['image_tensor'];prompt=a.prepared/row['prompt_file']
            assert sha(image)==row['image_sha256'] and sha(prompt)==row['prompt_sha256']
            data['images'].append(np.fromfile(image,dtype='<f4').reshape(1,3,640,640))
            data['prompt_embeddings'].append(np.fromfile(prompt,dtype='<f4').reshape(1,8,512))
    count=64 if a.kind=='reprta' else len(rows)
    r.update(source_onnx_sha256=sha(source),calibration_samples=count,state='calibrating');save()
    if a.reuse_calibration:
        prior=json.loads((a.reuse_calibration/'status.json').read_text())
        assert prior['kind']==a.kind and prior['source_onnx_sha256']==sha(source)
        assert prior['prepared_manifest_sha256']==r['prepared_manifest_sha256']
        calibrated_path=a.reuse_calibration/'model_calibrated_model.onnx'
        model=OnnxModel(str(a.reuse_calibration/'model_optimized_float_model.onnx'))
        builder=ModelBuilder(model,'nash-m',save_model=False,verbose=False);builder.original_model=model
        r.update(calibration_reused=True,calibration_source_sha256=sha(calibrated_path));save()
    else:
        model=OnnxModel(str(source))
        builder=ModelBuilder(model,'nash-m',save_model=True,verbose=False,name_prefix=str(a.output/'model'),
            cali_dict={'calibration_data':data},
            user_quant_config={'model_config':{'all_node_type':'int16','activation':{'calibration_type':'max'}}})
        ptq=builder.build();assert ptq is not None;onnx.save(ptq,a.output/'initial-ptq.onnx')
        calibrated_path=a.output/'model_calibrated_model.onnx'
    # Keep the statistics: later tuning must requantize saved graphs, not restart
    # the 512-image pass. Integer weights remain the original learned values.
    calibrated=OnnxModel(str(calibrated_path));changes=[]
    if a.kind=='reprta' and a.reuse_calibration:
        for node in calibrated.graph.nodes:
            if isinstance(node,CalibrationNode) and node.name.startswith(('/ReduceL2','/Clip','/Expand','/Div','prompt_embeddings')):
                node.qtype='float32';node.switch='OFF';changes.append(node.name)
    if a.detector_float_prompt_norm:
        # Zero unused slots create 1e12 reciprocal values at the epsilon floor.
        # Quantizing that reciprocal makes the valid unit-vector reciprocal 0.
        # Keep this normalization in floating VPU operations, then quantize its
        # final normalized vectors for the existing hardware MatMul contract.
        for node in calibrated.graph.nodes:
            if isinstance(node,CalibrationNode) and node.name.startswith(('/model.23/cv4.0/ReduceL2','/model.23/cv4.0/Clip','/model.23/cv4.0/Expand','/model.23/cv4.0/Div_reciprocal')):
                node.qtype='float32';node.switch='OFF';changes.append(node.name)
    if a.rewrite_float_clip:
            proto=calibrated.proto;rebuilt=[];count=0
            for node in proto.graph.node:
                target='/Clip' if a.kind=='reprta' else '/model.23/cv4.0/Clip'
                if node.op_type=='Clip' and node.name==target:
                    assert len(node.input)==3;count+=1;floor=node.name+'_floor'
                    rebuilt.append(onnx.helper.make_node('Max',list(node.input[:2]),[floor],name=floor))
                    rebuilt.append(onnx.helper.make_node('Min',[floor,node.input[2]],list(node.output),name=node.name+'_ceiling'))
                else:rebuilt.append(node)
            assert count==1;del proto.graph.node[:];proto.graph.node.extend(rebuilt)
            calibrated=OnnxModel(proto);changes.append('Clip -> exact Max/Min structure')
    if a.kind=='detector':
        for node in calibrated.graph.nodes:
            if not isinstance(node,CalibrationNode):continue
            if 'Softmax' in node.name and node.name.endswith('_sub_HzCalibration'):
                node.thresholds=np.array([16.],dtype=np.float32);node.qtype='int16';changes.append(node.name)
            # A joint box/score output must not quantize score probabilities
            # using a pixel-coordinate scale. Retain floating final structure.
            if '/model.23/Concat_4' in node.name or node.name.startswith('boxes_scores') or node.name.startswith('/Slice_'):
                node.qtype='float32';node.switch='OFF';changes.append(node.name)
    if a.reprta_weight_ec:
        from hmct.common import QuantConfig
        from hmct.quantizer.calibrater.weight.compensate_weight import CompensateWeight
        linear=[node.name for node in calibrated.graph.nodes if node.op_type=='Conv']
        assert set(linear)=={'/module/m/w12/MatMul','/module/m/w3/MatMul'}
        config=QuantConfig('nash-m')
        config.load_user_quant_config({'node_config':{name:{'input0':'int16','input1':'ec','output':'int16'} for name in linear}})
        compensated=CompensateWeight(config)(calibrated)
        assert compensated==2,compensated
        r.update(compensated_weight_ops=linear,weight_error_compensation_pass_changes=compensated)
        changes.append('Official HMCT weight EC: two learned linear weights split high/low INT8')
    if a.reprta_activation_headroom>1:
        ranges=[]
        for node in calibrated.graph.nodes:
            if isinstance(node,CalibrationNode) and node.tensor_type!='weight' and node.qtype=='int16' and node.switch=='ON':
                previous=np.array(node.thresholds,dtype=np.float32)
                assert previous.size and np.isfinite(previous).all() and (previous>0).all()
                node.thresholds=previous*a.reprta_activation_headroom
                ranges.append({'node':node.name,'previous':previous.tolist(),'updated':np.array(node.thresholds).tolist()})
        assert ranges
        r.update(reprta_activation_headroom=a.reprta_activation_headroom,activation_range_changes=ranges)
        changes.append('INT16 activation headroom from retained calibration; no validation samples added')
    if a.detector_matching_ec:
        from hmct.common import QuantConfig
        from hmct.quantizer.calibrater.activation.compensate_activation import CompensateActivation
        names=[node.name for node in calibrated.graph.nodes if node.op_type=='MatMul' and node.name.startswith('/model.23/cv4.')]
        assert set(names)=={'/model.23/cv4.0/MatMul','/model.23/cv4.1/MatMul','/model.23/cv4.2/MatMul'}
        config=QuantConfig('nash-m')
        config.load_user_quant_config({'node_config':{name:{'input0':'int16','input1':'ec','output':'int16'} for name in names}})
        count=CompensateActivation(config)(calibrated);assert count==3,count
        r.update(compensated_matching_matmuls=names,activation_error_compensation_pass_changes=count)
        changes.append('Official HMCT activation EC on three dynamic image-feature matching inputs')
    calibrated.infer_shapes().check_validity();onnx.save(calibrated.proto,a.output/'calibrated-candidate.onnx')
    ptq=builder.quantize(calibrated);ptq.infer_shapes().check_validity();onnx.save(ptq.proto,a.output/'ptq.onnx')
    r.update(state='converting',sensitive_precision_changes=changes);save()
    module=export(proto=ptq.proto,name='yoloe_'+a.kind)
    module=convert(module,march='nash-m',advice=True,advice_path=str(a.output)+'/')
    ops=json.loads((a.output/('yoloe_'+a.kind+'_advice.json')).read_text())
    cpu=[x for x in ops if x['backend']=='external_cpu']
    # Both component interfaces have no token or post-detection index logic.
    # Raw boxes/scores leave the graph; host NMS is implemented after inference.
    r.update(external_cpu_ops=cpu,cpu_neural_fallback_rejected_ops=cpu);save()
    assert ops and not cpu,'YOLOE component neural CPU fallback rejected'
    save_bc(module,str(a.output/'quantized.bc'))
    r.update(state='compiling',bc_sha256=sha(a.output/'quantized.bc'));save()
    compile(module,str(a.output/(a.kind+'.hbm')),march='nash-m',opt=0,jobs=a.jobs,debug=False,
            progress_bar=True,cache_mode='enable',cache_path=str(a.output/'compiler-cache'))
    r.update(state='compiled_needs_validation',hbm_sha256=sha(a.output/(a.kind+'.hbm')))
except BaseException as e:r.update(state='failed',error=repr(e));raise
finally:r['finished_unix']=time.time();save()
