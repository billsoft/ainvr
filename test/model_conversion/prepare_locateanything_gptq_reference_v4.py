"""Full decoder W4 GPTQ development oracle; no production CPU inference.

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
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from transformers import AutoConfig, AutoModel, AutoProcessor

parser = argparse.ArgumentParser()
for argument in ('model', 'baseline', 'out', 'packed'):
    parser.add_argument('--' + argument, required=True)
parser.add_argument('--group-size', type=int, choices=(32, 64, 128), default=128)
args = parser.parse_args()
GROUP_SIZE=args.group_size
out, packed, base = map(Path, (args.out, args.packed, args.baseline))
out.mkdir(parents=True, exist_ok=True)
packed.mkdir(parents=True, exist_ok=True)
baseline = json.loads((base / 'status.json').read_text())
assert baseline['status'] == 'completed'
assert len(baseline['cases'])==32 and all(case['status']=='completed' for case in baseline['cases'])
pilot_baseline=json.loads(Path('/work/full-native-reference-v1/status.json').read_text())
report = dict(status='loading', hbm_verified=False, group_size=GROUP_SIZE,
              scope='Original full model: all 36 decoder layers GPTQ W4; vision/connector/shared embedding-head/norm/bias BF16',
              calibration_images=[case['image_id'] for case in baseline['cases']], calibration_is_tuning_not_unseen=True,
              calibration_queries=sorted({case['query'] for case in baseline['cases']}),
              algorithm_reference='https://github.com/IST-DASLab/gptq',
              layers=[], modules=[], cases=[], started=time.time())
report.update(activation_order=True,static_groups=True,deployment_input_permutation_required=False)
ranges = {}


def save():
    (out / 'status.json').write_text(json.dumps(report, indent=2))


def quantize(name, module, hessian):
    begin=time.time();weight=module.weight.detach().float().clone();rows,columns=weight.shape
    metric=hessian.clone();dead=metric.diagonal()==0;metric[dead,dead]=1;weight[:,dead]=0
    # Static groups stay in original column order, making saved W4 payloads
    # usable without a deployment-time gather/permutation. Activation-order
    # changes only the error-feedback traversal, not model connectivity.
    scales=[];zeros=[]
    for start in range(0,columns,GROUP_SIZE):
        block=weight[:,start:min(start+GROUP_SIZE,columns)]
        low=torch.minimum(block.amin(1),torch.zeros(rows,device=weight.device))
        high=torch.maximum(block.amax(1),torch.zeros_like(low))
        scale=((high-low)/15).clamp_min(1e-12);zero=torch.round(-low/scale).clamp(0,15)
        scales.append(scale);zeros.append(zero)
    all_scales=torch.stack(scales,dim=1);all_zeros=torch.stack(zeros,dim=1)
    permutation=torch.argsort(metric.diagonal(),descending=True);inverse_permutation=torch.argsort(permutation)
    original_columns=permutation.cpu().tolist()
    weight=weight[:,permutation];metric=metric[permutation][:,permutation]
    diagonal=torch.arange(columns,device=weight.device);factor=None
    for damping in (.01,.02,.05,.1):
        trial=metric.clone();trial[diagonal,diagonal]+=damping*metric.diagonal().mean()
        try:
            inverse=torch.cholesky_inverse(torch.linalg.cholesky(trial));factor=torch.linalg.cholesky(inverse,upper=True);del inverse;break
        except torch.linalg.LinAlgError:continue
    if factor is None:raise RuntimeError('Activation-ordered Hessian factorization failed at all damping candidates')
    del trial,metric
    decoded=torch.empty_like(weight);codes=torch.empty((rows,columns),dtype=torch.uint8,device=weight.device)
    loss=torch.zeros((),device=weight.device)
    for first in range(0,columns,128):
        last=min(first+128,columns);block=weight[:,first:last].clone();corrections=torch.zeros_like(block);local_factor=factor[first:last,first:last]
        for column in range(last-first):
            group=original_columns[first+column]//GROUP_SIZE;scale=all_scales[:,group];zero=all_zeros[:,group]
            value=block[:,column];code=(torch.round(value/scale)+zero).clamp(0,15);restored=(code-zero)*scale
            decoded[:,first+column]=restored;codes[:,first+column]=code.to(torch.uint8)
            correction=(value-restored)/local_factor[column,column];loss+=correction.square().sum()
            block[:,column:]-=correction[:,None]*local_factor[column,column:][None,:];corrections[:,column]=correction
        if last<columns:weight[:,last:]-=corrections@factor[first:last,last:]
    decoded=decoded[:,inverse_permutation];codes=codes[:,inverse_permutation]
    module.weight.data.copy_(decoded.to(module.weight.dtype));torch.cuda.synchronize()
    nibble=codes.cpu().numpy();assert nibble.min()>=0 and nibble.max()<=15
    if columns%2:nibble=np.pad(nibble,((0,0),(0,1)))
    encoded=nibble[:,0::2]|(nibble[:,1::2]<<4)
    scale_data=all_scales.cpu().numpy();zero_data=all_zeros.to(torch.uint8).cpu().numpy()
    # Independently verify representation after undoing activation traversal.
    group_ids=np.arange(columns)//GROUP_SIZE
    reconstructed=(nibble[:,:columns].astype(np.float32)-zero_data[:,group_ids])*scale_data[:,group_ids]
    assert torch.equal(torch.from_numpy(reconstructed).to(module.weight.device,module.weight.dtype),module.weight.data)
    path=packed/(name+'.npz')
    np.savez(path,packed=encoded,scales=scale_data,zeros=zero_data,shape=np.array([rows,columns]),group_size=np.array(GROUP_SIZE),activation_order=permutation.cpu().numpy())
    report['modules'].append(dict(name=name,shape=[rows,columns],scheme='Static original groups, affine unsigned4 codes0..15; compiler signed code=code-8, zero=zero-8',packed_file=str(path),packed_payload_bytes=encoded.nbytes,scale_bytes=scale_data.nbytes,zero_bytes=zero_data.nbytes,damping_fraction=damping,dead_columns=int(dead.sum()),weighted_loss=float(loss),seconds=time.time()-begin,sha256=hashlib.sha256(path.read_bytes()).hexdigest(),activation_order=True,static_groups=True,deployment_input_permutation_required=False,packed_roundtrip_exact=True))
    save();print('quantized activation-order',name,time.time()-begin,flush=True)

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


save()
try:
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    assert torch.cuda.mem_get_info()[0] > 12 * 1024**3
    config = AutoConfig.from_pretrained(args.model, trust_remote_code=True)
    config._attn_implementation = 'sdpa'
    config.text_config._attn_implementation = 'sdpa'
    config.vision_config._attn_implementation = 'sdpa'
    model = AutoModel.from_pretrained(args.model, config=config, torch_dtype=torch.bfloat16,
        device_map={'': 'cuda:0'}, trust_remote_code=True, attn_implementation='sdpa').eval()
    processor = AutoProcessor.from_pretrained(args.model, trust_remote_code=True, use_fast=False)
    samples = []
    with torch.inference_mode():
        for reference_case in baseline['cases']:
            image_id=reference_case['image_id']
            for profile in ('slow', 'hybrid', 'teacher_slow'):
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
                                    profile=profile, image_id=image_id))
        report['calibration_samples'] = [dict(image_id=s['image_id'], profile=s['profile'],
                                             tokens=s['hidden'].shape[1]) for s in samples]
        report['status'] = 'quantizing'
        save()
        groups = [('self_attn.q_proj', 'self_attn.k_proj', 'self_attn.v_proj'),
                  ('self_attn.o_proj',), ('mlp.gate_proj', 'mlp.up_proj'), ('mlp.down_proj',)]
        for index, block in enumerate(model.language_model.model.layers):
            record = dict(index=index, status='running', started=time.time())
            report['layers'].append(record)
            save()
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
                metric.mul_(2 / max(count[0], 1))
                for name in names:
                    quantize(f'language_model.model.layers.{index}.{name}', block.get_submodule(name), metric)
                del metric
                torch.cuda.empty_cache()
            for sample in samples:
                sample['hidden'] = block(sample['hidden'], attention_mask=sample['mask'],
                    position_ids=sample['positions'], past_key_value=None, use_cache=False)[0].detach()
            record.update(status='completed', seconds=time.time()-record['started'])
            save()
            torch.cuda.empty_cache()
        del samples
        report['status'] = 'generating'
        save()
        def input_hook(name):
            def hook(module, inputs):
                ranges[name] = max(ranges.get(name, 0.0), float(inputs[0].detach().abs().max()))
            return hook
        handles = [m.register_forward_pre_hook(input_hook(n)) for n, m in model.named_modules()
                   if isinstance(m, torch.nn.Linear)]
        for image_id in (1144, 2444):
            for mode in ('slow', 'hybrid'):
                case = dict(image_id=image_id, generation_mode=mode, status='running')
                report['cases'].append(case)
                save()
                original = Image.open(f'/work/reference-image-{image_id}.jpg').convert('RGB')
                width, height = original.size
                image = original.resize((448, max(28, round(height*448/width/28)*28)), Image.Resampling.BICUBIC)
                messages = [{'role': 'user', 'content': [{'type': 'image', 'image': image}, {'type': 'text', 'text': 'person'}]}]
                text = processor.py_apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
                images, videos = processor.process_vision_info(messages)
                inputs = processor(text=[text], images=images, videos=videos, return_tensors='pt').to('cuda:0')
                torch.cuda.synchronize()
                begin = time.time()
                answer = model.generate(pixel_values=inputs['pixel_values'].to(torch.bfloat16),
                    input_ids=inputs['input_ids'], attention_mask=inputs['attention_mask'],
                    image_grid_hws=inputs['image_grid_hws'], tokenizer=processor.tokenizer,
                    max_new_tokens=128, use_cache=True, generation_mode=mode,
                    temperature=0.0, do_sample=False, verbose=False)
                torch.cuda.synchronize()
                answer = answer[0] if isinstance(answer, tuple) else answer
                reference = next(x for x in pilot_baseline['cases'] if x['image_id'] == image_id and x['generation_mode'] == mode)
                case.update(status='completed', response=answer, seconds=time.time()-begin,
                            terminated='<|im_end|>' in answer,
                            baseline_terminated='<|im_end|>' in reference['response'],
                            box_parity=comparison(boxes(reference['response']), boxes(answer)))
                save()
        for handle in handles:
            handle.remove()
    (out / 'linear-activation-ranges.json').write_text(json.dumps(ranges, indent=2))
    (packed / 'manifest.json').write_text(json.dumps(dict(scheme=f'group{GROUP_SIZE} affine unsigned4 nibble codes',
        modules=report['modules'], exclusions='vision/connector/shared embedding-head/norm/bias remain BF16'), indent=2))
    report.update(status='completed', finished=time.time(), whole_bpu_verified=False)
    save()
except BaseException:
    report.update(status='failed', error=traceback.format_exc())
    save()
    raise
