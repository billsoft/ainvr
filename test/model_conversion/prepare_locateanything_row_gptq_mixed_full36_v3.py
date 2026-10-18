"""Full36 sequential SDK-style W8 attention and row-GPTQ W4 MLP research oracle;original BF16 CUDA arithmetic,not BPU quality proof.

Algorithm reference: https://github.com/IST-DASLab/gptq
The original vision, connector, shared embedding/head, norms and bias remain BF16.
"""
import os
os.environ.setdefault('HF_HOME', '/work/reference-cache')
import argparse
import hashlib
import json
import re
import time
import traceback
import signal
import sys
sys.path.insert(0, '/opt/locate-reference-deps')
sys.path.insert(0, '/work/official-llm-v1')
from validate_locateanything_official_heldout_bpu_v2 import parse_response, maximum_matches, iou
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from transformers import AutoConfig, AutoModel, AutoProcessor

parser = argparse.ArgumentParser()
for argument in ('model', 'baseline', 'out', 'packed'):
    parser.add_argument('--' + argument, required=True)
args = parser.parse_args()
GROUP_SIZE=-1
out, packed, base = map(Path, (args.out, args.packed, args.baseline))
out.mkdir(parents=True, exist_ok=False)
packed.mkdir(parents=True, exist_ok=False)
baseline = json.loads((base / 'status.json').read_text())
assert baseline['status'] == 'completed'
assert len(baseline['cases'])==32 and all(case['status']=='completed' for case in baseline['cases'])
development_path=Path('/work/heldout-native-reference-v1/status.json')
development=json.loads(development_path.read_text())
assert development['status']=='completed' and len(development['cases'])==64
assert not {c['image_id'] for c in development['cases']}.intersection(c['image_id'] for c in baseline['cases'])
report = dict(status='loading', hbm_verified=False, group_size=GROUP_SIZE,
              scope='All36 original text layers:W8 attention and row-GPTQ signedW4 MLP;original vision/connector/shared embedding-head/norm/bias BF16 CUDA research. No neural production fallback.',
              calibration_images=[case['image_id'] for case in baseline['cases']], calibration_is_tuning_not_unseen=True,
              calibration_queries=sorted({case['query'] for case in baseline['cases']}),
              algorithm_reference='https://github.com/IST-DASLab/gptq',
              layers=[], modules=[], cases=[], started=time.time())
ranges = {}
report.update(source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              development_reference_sha256=hashlib.sha256(development_path.read_bytes()).hexdigest(),
              calibration_reference_sha256=hashlib.sha256((base/'status.json').read_bytes()).hexdigest(),
              fresh_final_used=False, board_calls=0, release_approved=False,
              whole_model_bpu_verified=False, logical_weight_bits='attention8_mlp4',calibration_strategy='Recollect activations after each quantized group/layer;not checkpoint splicing')
def available():return int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024
def interrupted(*_):raise RuntimeError('Owned full36 row-GPTQ research interrupted')
signal.signal(signal.SIGTERM,interrupted)


def save():
    temporary=out/'status.json.tmp';temporary.write_text(json.dumps(report,indent=2)+'\n');temporary.replace(out/'status.json')


def prepare_hessian(metric):
    h=metric.clone();dead=h.diagonal()==0;h[dead,dead]=1
    permutation=torch.argsort(h.diagonal(),descending=True);h=h[permutation][:,permutation]
    diagonal=torch.arange(h.shape[0],device=h.device);h[diagonal,diagonal]+=.01*h.diagonal().mean()
    inverse=torch.cholesky_inverse(torch.linalg.cholesky(h));factor=torch.linalg.cholesky(inverse,upper=True)
    return factor,permutation,dead

def quantize_attention_w8(name,module):
    begin=time.time();original=module.weight.detach();original_hash=hashlib.sha256(original.cpu().contiguous().view(torch.uint8).numpy().tobytes()).hexdigest();weight=original.float();rows,columns=weight.shape
    scale=(weight.abs().amax(dim=1,keepdim=True)/127).clamp_min(1e-12);codes=torch.round(weight/scale).clamp(-127,127).to(torch.int8);decoded=codes.float()*scale;module.weight.copy_(decoded.to(module.weight.dtype));signed=codes.cpu().numpy();scale_data=scale.cpu().numpy();assert torch.equal(torch.from_numpy(signed).to(module.weight.device,torch.float32)*torch.from_numpy(scale_data).to(module.weight.device),decoded)
    path=packed/(name+'.npz');np.savez(path,codes=signed,scales=scale_data,shape=np.array([rows,columns]),weight_bits=np.array(8),group_size=np.array(-1),signed_code_offset=np.array(0),code_min=np.array(-127),code_max=np.array(127))
    report['modules'].append(dict(name=name,shape=[rows,columns],scheme='Official-style per-row symmetric INT8 absmax/127;compiler retains original weights for official FQLinear W8 export',logical_weight_bits=8,packed_file=str(path),packed_payload_bytes=signed.nbytes,scale_bytes=scale_data.nbytes,zero_bytes=0,packed_roundtrip_exact=True,deployment_input_permutation_required=False,original_bf16_parameter_sha256=original_hash,research_weight_dtype=str(module.weight.dtype),compiler_uses_original_weight_for_w8=True,seconds=time.time()-begin,sha256=hashlib.sha256(path.read_bytes()).hexdigest()));save()

def diagnostic_outputs(block,selected):
    outputs=[block(s['hidden'],attention_mask=s['mask'],position_ids=s['positions'],past_key_value=None,use_cache=False)[0].detach().float() for s in selected]
    report['gpu_diagnostic_layer_forward_calls']+=len(selected)
    return outputs

def diagnostic_errors(outputs,reference,selected):
    rows=[]
    for out,gold,sample in zip(outputs,reference,selected):
        error=float(torch.linalg.vector_norm(out-gold)/torch.linalg.vector_norm(gold).clamp_min(1e-12));rows.append(dict(image_id=sample['image_id'],query=sample['query'],profile=sample['profile'],hidden_rel_l2=error))
    return dict(cases=rows,median_hidden_rel_l2=float(np.median([x['hidden_rel_l2'] for x in rows])),maximum_hidden_rel_l2=max(x['hidden_rel_l2'] for x in rows))

def quantize(name,module,factor,permutation,dead):
    begin=time.time();assert available()>6*1024**3
    original=module.weight.detach();weight=original.float().clone();rows,columns=weight.shape
    original_hash=hashlib.sha256(original.cpu().contiguous().view(torch.uint8).numpy().tobytes()).hexdigest()
    maximum=weight.abs().amax(dim=1,keepdim=True);best=torch.full((rows,),float('inf'),device=weight.device);scale=(maximum/7).clamp_min(1e-12)
    for i in range(16):
        trial=(maximum*(1-i/20)/7).clamp_min(1e-12)
        error=(torch.round(weight/trial).clamp(-7,7)*trial-weight).abs().pow(2.4).sum(1);take=error<best;scale[take]=trial[take];best[take]=error[take]
    weight[:,dead]=0;weight=weight[:,permutation];decoded=torch.empty_like(weight)
    for first in range(0,columns,128):
        last=min(first+128,columns);block=weight[:,first:last].clone();corrections=torch.zeros_like(block);local=factor[first:last,first:last]
        for column in range(last-first):
            value=block[:,column];restored=torch.round(value/scale[:,0]).clamp(-7,7)*scale[:,0];decoded[:,first+column]=restored
            correction=(value-restored)/local[column,column];block[:,column:]-=correction[:,None]*local[column,column:][None,:];corrections[:,column]=correction
        if last<columns:weight[:,last:]-=corrections@factor[first:last,last:]
    decoded=decoded[:,torch.argsort(permutation)];codes=torch.round(decoded/scale).clamp(-7,7).to(torch.int8)
    assert torch.equal(codes.float()*scale,decoded),'Prepared values must roundtrip through the official signed W4 grid'
    module.weight.data.copy_(decoded.to(module.weight.dtype));torch.cuda.synchronize()
    signed=codes.cpu().numpy();assert signed.min()>=-7 and signed.max()<=7 and columns%2==0
    unsigned=(signed.astype(np.int16)+8).astype(np.uint8);encoded=unsigned[:,0::2]|(unsigned[:,1::2]<<4)
    unpacked=np.empty_like(unsigned);unpacked[:,0::2]=encoded&15;unpacked[:,1::2]=encoded>>4
    assert np.array_equal(unpacked.astype(np.int16)-8,signed)
    scale_data=scale.cpu().numpy();reconstructed=(unpacked.astype(np.float32)-8)*scale_data
    assert torch.equal(torch.from_numpy(reconstructed).to(module.weight.device,module.weight.dtype),module.weight.data),'Research BF16 weight differs from prepared-grid BF16 rounding'
    path=packed/(name+'.npz');np.savez(path,packed=encoded,scales=scale_data,shape=np.array([rows,columns]),weight_bits=np.array(4),group_size=np.array(-1),signed_code_offset=np.array(8),code_min=np.array(-7),code_max=np.array(7))
    report['modules'].append(dict(name=name,shape=[rows,columns],scheme='Per-row signed[-7,7],zero0;stored nibble=code+8,scale[out,1]',logical_weight_bits=4,packed_file=str(path),packed_payload_bytes=encoded.nbytes,scale_bytes=scale_data.nbytes,zero_bytes=0,packed_roundtrip_exact=True,damping_fraction=.01,dead_columns=int(dead.sum()),activation_order=True,deployment_input_permutation_required=False,original_bf16_parameter_sha256=original_hash,research_weight_dtype=str(module.weight.dtype),prepared_float32_grid_bf16_rounding_exact=True,seconds=time.time()-begin,sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    save();print('row-GPTQ',name,time.time()-begin,flush=True)


def boxes(text):
    return [list(map(int, re.findall(r'<(\d+)>', box)))
            for box in re.findall(r'<box>(.*?)</box>', text)
            if len(re.findall(r'<(\d+)>', box)) == 4]


def overlap(x, y):
    intersection = max(0, min(x[2], y[2])-max(x[0], y[0])) * max(0, min(x[3], y[3])-max(x[1], y[1]))
    area = max(0, x[2]-x[0])*max(0, x[3]-x[1]) + max(0, y[2]-y[0])*max(0, y[3]-y[1]) - intersection
    return intersection / area if area else 0.0


def comparison(reference, prediction):
    pairs = sorted([(overlap(x, y), i, j) for i, x in enumerate(reference)
                    for j, y in enumerate(prediction)], reverse=True)
    used_reference, used_prediction, matched = set(), set(), []
    for score, i, j in pairs:
        if score >= 0.9 and i not in used_reference and j not in used_prediction:
            used_reference.add(i)
            used_prediction.add(j)
            matched.append(score)
    return dict(reference_count=len(reference), candidate_count=len(prediction),
                matched_iou_0_9=len(matched),
                precision=len(matched)/len(prediction) if prediction else float(not reference),
                recall=len(matched)/len(reference) if reference else float(not prediction),
                mean_matching_iou=float(np.mean(matched)) if matched else 0.0)


assert report['calibration_reference_sha256']=='2f2946d98ea485578896fa59015480094b197354fa573ff1329e0e8ca78a86ea' and report['development_reference_sha256']=='73d68ba78b7226cabef825cf652b8fbae8f0b4e894c5e0c1612a4b46571600d0'
report['calibration_unique_images']=len({x['image_id'] for x in baseline['cases']});report['development_unique_images']=len({x['image_id'] for x in development['cases']})
report['precision_policy']='Attention144 projections W8;MLP108 projections W4;shared head/vision/embedding/norm/bias original BF16 research'
report['component_decision_sha256']='e0bb9bd165d61b3051e1167de8f61e95ba857db09a4c60d98f5ddd8275a5e257'
assert hashlib.sha256(Path('/work/official-llm-v1/locateanything-official-row-gptq-layer-decision-v2.json').read_bytes()).hexdigest()==report['component_decision_sha256']
save()
try:
    torch.set_num_threads(2)
    assert available()>14*1024**3
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    assert torch.cuda.mem_get_info()[0] > 14 * 1024**3
    model_dir=Path(args.model)
    for filename,pin in [('config.json','59e6b5104f9d948db6a38f778e29f86d5c01e373f46d02008fc3070377917007'),('model.safetensors.index.json','2ecc63fee5f958ffc8142fa29ff7b704a58e80349e9c9ca155a9710d97700271')]:
        assert hashlib.sha256((model_dir/filename).read_bytes()).hexdigest()==pin,filename
    def source_digest(path):
        h=hashlib.sha256()
        with path.open('rb') as f:
            for chunk in iter(lambda:f.read(4194304),b''):h.update(chunk)
        return h.hexdigest()
    canonical_tokenizer=Path('/work/official-llm-v1/tokenizer-original-v1.json')
    assert source_digest(canonical_tokenizer)=='f56587c1c7b4d69be60b018606b1bf2f90e46ca9d51fb2689090997281df7e40'
    report['canonical_tokenizer_sha256']=source_digest(canonical_tokenizer)
    report['original_checkpoint_files_sha256']={p.name:source_digest(p) for p in sorted(model_dir.iterdir()) if p.suffix in ['.py','.safetensors'] or p.name in ['config.json','model.safetensors.index.json','vocab.json','merges.txt','added_tokens.json','tokenizer_config.json','special_tokens_map.json','processor_config.json','preprocessor_config.json']}
    report['software_versions']=dict(torch=torch.__version__,numpy=np.__version__,cuda=torch.version.cuda,gpu=torch.cuda.get_device_name(),tf32_matmul=False,tf32_cudnn=False)
    save()
    config = AutoConfig.from_pretrained(args.model, trust_remote_code=True)
    config._attn_implementation = 'sdpa'
    config.text_config._attn_implementation = 'sdpa'
    config.vision_config._attn_implementation = 'sdpa'
    model = AutoModel.from_pretrained(args.model, config=config, torch_dtype=torch.bfloat16,
        device_map={'': 'cuda:0'}, trust_remote_code=True, attn_implementation='sdpa').eval()
    assert len(model.language_model.model.layers)==36 and len(model.vision_model.encoder.blocks)==27
    assert sum(p.numel() for p in model.parameters())==3517975280
    assert model.language_model.model.embed_tokens.weight.data_ptr()==model.language_model.lm_head.weight.data_ptr()
    report.update(original_parameter_count=3517975280,text_layers=36,vision_blocks=27,vocabulary_size=152681,gpu_diagnostic_layer_forward_calls=0,gpu_calibration_layer_forward_calls=0,gpu_full_generation_requests=0,overall_elapsed_cap_seconds=None,weight_scale_shape='out_features,1',signed_code_ranges={'mlp_w4':[-7,7],'attention_w8':[-127,127]},weight_preparation='MSE grid20/maxshrink.8/norm2.4 then GPTQ actorder/block128/damping.01',official_linear_unmodified=True,research_math='Original BF16 CUDA operations;serialized compiler grid is F32,not a BPU output oracle',generation_parameters=dict(max_new_tokens=256,generation_mode='slow',temperature=0.,do_sample=False,use_cache=True))
    processor = AutoProcessor.from_pretrained(args.model, trust_remote_code=True, use_fast=False)
    from tokenizers import Tokenizer
    canonical=Tokenizer.from_file(str(canonical_tokenizer));vocabulary=processor.tokenizer.get_vocab()
    assert vocabulary==canonical.get_vocab(), 'Original processor and deployed tokenizer vocabulary differ'
    texts={c['query'] for c in baseline['cases']+development['cases']}|{c['response'] for c in baseline['cases']+development['cases']}|{'Point to: person.','Point to: car.','  a person\ncar','café Straße','中文 着火 图像','<box><1><2><3><4></box><|im_end|>'}
    for text in texts:
        ids=processor.tokenizer.encode(text,add_special_tokens=False)
        assert ids==canonical.encode(text,add_special_tokens=False).ids,'Tokenizer encode differs'
        assert processor.tokenizer.decode(ids,skip_special_tokens=False,clean_up_tokenization_spaces=False)==canonical.decode(ids,skip_special_tokens=False),'Tokenizer decode differs'
    report['original_and_deployed_tokenizer_validation']=dict(vocabulary_count=len(vocabulary),full_vocab_equal=True,text_encode_decode_cases=len(texts),encoded_ids_equal=True,decoded_text_equal=True,original_processor_retained=True);save()
    samples = []
    with torch.inference_mode():
        for reference_case in baseline['cases']:
            image_id=reference_case['image_id']
            for profile in ('slow', 'hybrid', 'teacher_slow'):
                if profile=='teacher_slow' and (not reference_case['terminated'] or parse_response(reference_case['response'])['malformed_blocks']):continue
                directory = Path(reference_case['directory']) / 'lm-call-0'
                ids = torch.from_numpy(np.load(directory / 'input_ids.npy')).to('cuda:0')
                positions = torch.from_numpy(np.load(directory / 'position_ids.npy')).to('cuda:0')
                visual = torch.from_numpy(np.load(directory / 'visual_features.npy')).to('cuda:0', torch.bfloat16)
                if profile=='hybrid':
                    future=torch.full((1,5),model.token_ids['default_mask_token_id'],device='cuda:0',dtype=ids.dtype)
                    ids=torch.cat((ids,ids[:,-1:],future),dim=1)
                    positions=torch.arange(ids.shape[1],device='cuda:0')[None,:]
                    positions[:,-6:]-=1
                if profile == 'teacher_slow':
                    answer = reference_case['response']
                    suffix = torch.tensor(processor.tokenizer.encode(answer, add_special_tokens=False), device='cuda:0')[None, :]
                    ids = torch.cat([ids, suffix], dim=1)
                    positions = torch.arange(ids.shape[1], device='cuda:0')[None, :]
                hidden = model.language_model.model.image_processing(ids, visual, config.image_token_index)
                length = ids.shape[1]
                mask = torch.triu(torch.full((1, 1, length, length), torch.finfo(torch.bfloat16).min,
                                            device='cuda:0', dtype=torch.bfloat16), diagonal=1)
                if profile == 'hybrid':
                    mask[:, :, -6:, -6:] = 0
                    mask[:, :, -6:, -7] = torch.finfo(torch.bfloat16).min
                samples.append(dict(hidden=hidden.detach(), mask=mask, positions=positions,
                                    profile=profile, image_id=image_id,query=reference_case['query']))
        report['calibration_samples'] = [dict(image_id=s['image_id'], profile=s['profile'],
                                             tokens=s['hidden'].shape[1]) for s in samples]
        report['status'] = 'quantizing'
        save()
        groups = [('mlp.gate_proj','mlp.up_proj'),('mlp.down_proj',)]
        diagnostics=[]
        for query in sorted({s['query'] for s in samples}):
            diagnostics.extend([s for s in samples if s['profile']=='slow' and s['query']==query][:2])
        assert len(diagnostics)==8
        report['diagnostic_selection']=[dict(image_id=s['image_id'],query=s['query'],profile=s['profile']) for s in diagnostics]
        report['diagnostic_scope']='Each original current layer vs quantized current layer on identical incoming states from previously quantized layers;conditional calibration sensitivity,not full-model P/R'
        for index, block in enumerate(model.language_model.model.layers):
            assert available()>6*1024**3
            assert torch.cuda.mem_get_info()[0]>2*1024**3,'Preserve2GiB GPU headroom before next layer'
            record = dict(index=index, status='running', started=time.time())
            report['layers'].append(record)
            save()
            original_diagnostic=diagnostic_outputs(block,diagnostics)
            for suffix in ['self_attn.q_proj','self_attn.k_proj','self_attn.v_proj','self_attn.o_proj']:
                quantize_attention_w8(f'language_model.model.layers.{index}.{suffix}',block.get_submodule(suffix))
            record['attention_w8_conditional']=diagnostic_errors(diagnostic_outputs(block,diagnostics),original_diagnostic,diagnostics)
            record['mlp_quantization_groups']=[]
            for names in groups:
                first_module = block.get_submodule(names[0])
                width = first_module.in_features
                metric = torch.zeros((width, width), device='cuda:0', dtype=torch.float32)
                count = [0]
                def collect(module, inputs):
                    x = inputs[0].detach().reshape(-1, width).float()
                    metric.add_(x.T @ x)
                    count[0] += x.shape[0]
                handle = first_module.register_forward_pre_hook(collect)
                for sample in samples:
                    block(sample['hidden'], attention_mask=sample['mask'], position_ids=sample['positions'],
                          past_key_value=None, use_cache=False)
                handle.remove()
                report['gpu_calibration_layer_forward_calls']+=len(samples)
                metric.mul_(2 / max(count[0], 1))
                factor,permutation,dead=prepare_hessian(metric)
                for name in names:
                    quantize(f'language_model.model.layers.{index}.{name}', block.get_submodule(name), factor,permutation,dead)
                del metric,factor,permutation,dead
                record['mlp_quantization_groups'].append(dict(projections=list(names),conditional=diagnostic_errors(diagnostic_outputs(block,diagnostics),original_diagnostic,diagnostics)))
                save()
                torch.cuda.empty_cache()
            for sample in samples:
                sample['hidden'] = block(sample['hidden'], attention_mask=sample['mask'],
                    position_ids=sample['positions'], past_key_value=None, use_cache=False)[0].detach()
            report['gpu_calibration_layer_forward_calls']+=len(samples)
            record.update(status='completed', seconds=time.time()-record['started'])
            save()
            torch.cuda.empty_cache()
        del samples
        assert len(report['modules'])==252 and all(m['packed_roundtrip_exact'] for m in report['modules'])
        manifest=dict(scheme='Original36 text layers:SDK-style symmetricW8 attention and symmetric row-GPTQ W4 MLP;scale[out,1],sequentially recalibrated after W8 attention',modules=report['modules'],
                      exclusions='vision/connector/shared embedding-head/norm/bias remain BF16',
                      source_sha256=report['source_sha256'])
        manifest_path=packed/'manifest.json';manifest_path.write_text(json.dumps(manifest,indent=2)+'\n')
        report['manifest_sha256']=hashlib.sha256(manifest_path.read_bytes()).hexdigest()
        report['logical_decoder_weight_payload_bytes']=sum(m['packed_payload_bytes'] for m in report['modules'])
        total=sum(m['shape'][0]*m['shape'][1] for m in report['modules']);four=sum(m['shape'][0]*m['shape'][1] for m in report['modules'] if m['logical_weight_bits']==4);report['w4_decoder_parameter_fraction']=four/total;assert four/total>=.8
        report['decoder_scale_zero_bytes']=sum(m['scale_bytes']+m['zero_bytes'] for m in report['modules'])
        report['status']='generating_old64_development';save()
        for reference in development['cases']:
            directory=Path(reference['directory']);assert directory.is_relative_to(development_path.parent)
            prepared={key:torch.from_numpy(np.load(directory/f'prepared-{key}.npy')).to('cuda:0') for key in ('pixel_values','input_ids','attention_mask','image_grid_hws')}
            begin=time.time()
            answer=model.generate(pixel_values=prepared['pixel_values'].to(torch.bfloat16),input_ids=prepared['input_ids'],attention_mask=prepared['attention_mask'],image_grid_hws=prepared['image_grid_hws'],tokenizer=processor.tokenizer,max_new_tokens=256,use_cache=True,generation_mode='slow',temperature=0.,do_sample=False,verbose=False)
            report['gpu_full_generation_requests']+=1
            answer=answer[0] if isinstance(answer,tuple) else answer
            bodies=re.findall(r'<box>(.*?)</box>',answer);malformed=[]
            if answer.count('<box>')!=len(bodies):malformed.append('unclosed_box')
            for body in bodies:
                if body=='None':continue
                if not re.fullmatch(r'(?:<\d+>){4}',body):malformed.append('invalid_box_tokens');continue
                coords=list(map(int,re.findall(r'<(\d+)>',body)))
                if not all(0<=c<=1000 for c in coords) or coords[0]>=coords[2] or coords[1]>=coords[3]:malformed.append('invalid_box_geometry')
            a,b=parse_response(reference['response']),parse_response(answer)
            matches=maximum_matches(a['boxes'],b['boxes'],lambda x,y:iou(x,y)>=.9)
            report['cases'].append(dict(image_id=reference['image_id'],query=reference['query'],response=answer,terminated='<|im_end|>' in answer,malformed=sorted(set(malformed+b['malformed_blocks']+(['unexpected_point_output'] if b['points'] else []))),matched=len(matches),candidate=len(b['boxes']),reference=len(a['boxes']),seconds=time.time()-begin));save()
        matched=sum(c['matched'] for c in report['cases']);predicted=sum(c['candidate'] for c in report['cases']);total=sum(c['reference'] for c in report['cases'])
        report['aggregate']=dict(matched=matched,candidate=predicted,reference=total,precision=matched/predicted if predicted else float(total==0),recall=matched/total if total else float(predicted==0),all_terminal=all(c['terminated'] for c in report['cases']),all_well_formed=all(not c['malformed'] for c in report['cases']))
        aggregate=report['aggregate'];report['old_development_floor_passed']=aggregate['precision']>=.45 and aggregate['recall']>=.45 and aggregate['all_terminal'] and aggregate['all_well_formed']
    report.update(status='completed', finished=time.time(), whole_bpu_verified=False)
    save()
except BaseException:
    report.update(status='failed', error=traceback.format_exc())
    save()
    raise

finally:
    report['finished']=time.time()
    if torch.cuda.is_available():
        report['cuda_peak_allocated_bytes']=torch.cuda.max_memory_allocated()
        report['cuda_peak_reserved_bytes']=torch.cuda.max_memory_reserved()
    save()
