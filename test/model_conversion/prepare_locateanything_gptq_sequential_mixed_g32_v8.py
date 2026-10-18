"""Sequential mixed W4-MLP/W8-attention GPTQ development oracle; no production CPU inference.

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
parser.add_argument('--group-size', type=int, choices=(32,), default=32)
args = parser.parse_args()
GROUP_SIZE=args.group_size
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
              scope='Original full model: all 36 decoder layers GPTQ W4-MLP/W8-attention; vision/connector/shared embedding-head/norm/bias BF16',
              calibration_images=[case['image_id'] for case in baseline['cases']], calibration_is_tuning_not_unseen=True,
              calibration_queries=sorted({case['query'] for case in baseline['cases']}),
              algorithm_reference='https://github.com/IST-DASLab/gptq',
              layers=[], modules=[], cases=[], started=time.time())
ranges = {}
report.update(source_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              development_reference_sha256=hashlib.sha256(development_path.read_bytes()).hexdigest(),
              calibration_reference_sha256=hashlib.sha256((base/'status.json').read_bytes()).hexdigest(),
              fresh_final_used=False, board_calls=0, release_approved=False,
              whole_model_bpu_verified=False, logical_weight_bits='mixed4_8',calibration_strategy='Recollect activations after each quantized group/layer;not checkpoint splicing')
def available():return int(Path('/proc/meminfo').read_text().split('MemAvailable:')[1].split()[0])*1024
def interrupted(*_):raise RuntimeError('Owned group16 quantization interrupted or2400second limit')
signal.signal(signal.SIGTERM,interrupted);signal.signal(signal.SIGALRM,interrupted);signal.alarm(2400)


def save():
    temporary=out/'status.json.tmp';temporary.write_text(json.dumps(report,indent=2)+'\n');temporary.replace(out/'status.json')


def quantize(name, module, hessian):
    begin = time.time()
    BITS=8 if '.self_attn.' in name else 4
    LEVELS=2**BITS-1
    assert available()>6*1024**3,'Preserve ordinary RAM headroom'
    weight = module.weight.detach().float().clone()
    rows, columns = weight.shape
    metric = hessian.clone()
    dead = metric.diagonal() == 0
    metric[dead, dead] = 1
    weight[:, dead] = 0
    diagonal = torch.arange(columns, device=weight.device)
    factor = None
    for damping in (0.01, 0.02, 0.05, 0.1):
        trial = metric.clone()
        trial[diagonal, diagonal] += damping * metric.diagonal().mean()
        try:
            inverse = torch.cholesky_inverse(torch.linalg.cholesky(trial))
            factor = torch.linalg.cholesky(inverse, upper=True)
            del inverse
            break
        except torch.linalg.LinAlgError:
            continue
    if factor is None:
        raise RuntimeError('Hessian factorization failed at all recorded damping candidates')
    del trial, metric
    decoded = torch.empty_like(weight)
    codes = torch.empty((rows, columns), dtype=torch.uint8, device=weight.device)
    scales, zeros, loss = [], [], torch.zeros((),device=weight.device)
    for first in range(0, columns, GROUP_SIZE):
        last = min(first + GROUP_SIZE, columns)
        block = weight[:, first:last].clone()
        corrections = torch.zeros_like(block)
        local_factor = factor[first:last, first:last]
        low = torch.minimum(block.amin(1), torch.zeros(rows, device=weight.device))
        high = torch.maximum(block.amax(1), torch.zeros_like(low))
        scale = ((high - low) / LEVELS).clamp_min(1e-12)
        zero = torch.round(-low / scale).clamp(0, LEVELS)
        scales.append(scale.cpu())
        zeros.append(zero.to(torch.uint8).cpu())
        for column in range(last - first):
            value = block[:, column]
            code = (torch.round(value / scale) + zero).clamp(0, LEVELS)
            restored = (code - zero) * scale
            decoded[:, first + column] = restored
            codes[:, first + column] = code.to(torch.uint8)
            correction = (value - restored) / local_factor[column, column]
            loss += correction.square().sum()
            block[:, column:] -= correction[:, None] * local_factor[column, column:][None, :]
            corrections[:, column] = correction
        if last < columns:
            weight[:, last:] -= corrections @ factor[first:last, last:]
    module.weight.data.copy_(decoded.to(module.weight.dtype))
    torch.cuda.synchronize()
    nibble = codes.cpu().numpy()
    assert nibble.min() >= 0 and nibble.max() <= LEVELS
    if columns % 2:
        nibble = np.pad(nibble, ((0, 0), (0, 1)))
    encoded = (nibble[:, 0::2] | (nibble[:, 1::2] << 4)) if BITS==4 else nibble.copy()
    scale_data = torch.stack(scales, dim=1).numpy()
    zero_data = torch.stack(zeros, dim=1).numpy()
    if BITS==4:
        redecoded=np.empty((rows,encoded.shape[1]*2),dtype=np.uint8)
        redecoded[:,0::2]=encoded&15;redecoded[:,1::2]=encoded>>4
    else:redecoded=encoded.copy()
    assert np.array_equal(redecoded[:,:columns],nibble[:,:columns])
    ids=np.arange(columns)//GROUP_SIZE
    reconstructed=(redecoded[:,:columns].astype(np.float32)-zero_data[:,ids])*scale_data[:,ids]
    assert torch.equal(torch.from_numpy(reconstructed).to(module.weight.device,module.weight.dtype),module.weight.data)
    path = packed / (name + '.npz')
    payload=dict(scales=scale_data,zeros=zero_data,shape=np.array([rows,columns]),group_size=np.array(GROUP_SIZE),weight_bits=np.array(BITS))
    payload['packed' if BITS==4 else 'codes']=encoded
    np.savez(path,**payload)
    report['modules'].append(dict(name=name, shape=[rows, columns],
        scheme=f'affine unsigned{BITS}; explicit bits and payload key',logical_weight_bits=BITS,
        packed_file=str(path), packed_payload_bytes=encoded.nbytes,
        scale_bytes=scale_data.nbytes, zero_bytes=zero_data.nbytes,
        packed_roundtrip_exact=True, damping_fraction=damping, dead_columns=int(dead.sum()), weighted_loss=float(loss),
        seconds=time.time()-begin, sha256=hashlib.sha256(path.read_bytes()).hexdigest()))
    save()
    print('quantized', name, time.time()-begin, flush=True)


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
    torch.set_num_threads(2)
    assert available()>14*1024**3
    torch.backends.cuda.matmul.allow_tf32 = False
    torch.backends.cudnn.allow_tf32 = False
    assert torch.cuda.mem_get_info()[0] > 14 * 1024**3
    config = AutoConfig.from_pretrained(args.model, trust_remote_code=True)
    config._attn_implementation = 'sdpa'
    config.text_config._attn_implementation = 'sdpa'
    config.vision_config._attn_implementation = 'sdpa'
    model = AutoModel.from_pretrained(args.model, config=config, torch_dtype=torch.bfloat16,
        device_map={'': 'cuda:0'}, trust_remote_code=True, attn_implementation='sdpa').eval()
    assert len(model.language_model.model.layers)==36 and len(model.vision_model.encoder.blocks)==27
    assert sum(p.numel() for p in model.parameters())==3517975280
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
            assert available()>6*1024**3
            assert torch.cuda.mem_get_info()[0]>2*1024**3,'Preserve2GiB GPU headroom before next layer'
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
        assert len(report['modules'])==252 and all(m['packed_roundtrip_exact'] for m in report['modules'])
        manifest=dict(scheme='group32 affine W4-MLP(nibbles) and W8-attention(uint8), sequentially recalibrated',modules=report['modules'],
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
            answer=model.generate(pixel_values=prepared['pixel_values'].to(torch.bfloat16),input_ids=prepared['input_ids'],attention_mask=prepared['attention_mask'],image_grid_hws=prepared['image_grid_hws'],tokenizer=processor.tokenizer,max_new_tokens=128,use_cache=True,generation_mode='slow',temperature=0.,do_sample=False,verbose=False)
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
            report['cases'].append(dict(image_id=reference['image_id'],query=reference['query'],response=answer,terminated='<|im_end|>' in answer,malformed=malformed,matched=len(matches),candidate=len(b['boxes']),reference=len(a['boxes']),seconds=time.time()-begin));save()
        matched=sum(c['matched'] for c in report['cases']);predicted=sum(c['candidate'] for c in report['cases']);total=sum(c['reference'] for c in report['cases'])
        report['aggregate']=dict(matched=matched,candidate=predicted,reference=total,precision=matched/predicted if predicted else float(total==0),recall=matched/total if total else float(predicted==0),all_terminal=all(c['terminated'] for c in report['cases']),all_well_formed=all(not c['malformed'] for c in report['cases']))
        aggregate=report['aggregate'];report['old_development_floor_passed']=aggregate['precision']>=.6 and aggregate['recall']>=.6 and aggregate['all_terminal'] and aggregate['all_well_formed']
    report.update(status='completed', finished=time.time(), whole_bpu_verified=False)
    save()
except BaseException:
    report.update(status='failed', error=traceback.format_exc())
    save()
    raise

finally:
    signal.alarm(0)
