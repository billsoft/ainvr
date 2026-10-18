"""Real complete LocateAnything decoder layer, selected calibrated INT8 plus 5% INT16 logical weights, BPU candidate.

This is an architectural/placement/precision component experiment, not whole-model
acceptance. Original custom masks and position-derived RoPE are explicit inputs.
Development Torch math is an oracle only; every HBM node must be BPU.
"""
import os
for key in ('DEV_B30_TRITON_VPU', 'DEV_B30_ENABLE_VPU_EXTRA_OP', 'DEV_B30_ENABLE_VPU_TRIAL_OP'):
    os.environ[key] = '1'
os.environ.setdefault('HF_HOME', '/work/reference-cache')
import argparse
import hashlib
import json
import math
import time
import traceback
import signal
from locateanything_normalized_rsqrt_bpu import rsqrt_positive_bpu
from locateanything_float_softmax_bpu import softmax_float_bpu
from pathlib import Path
import numpy as np
import torch
import torch.nn.functional as F
from safetensors import safe_open
from hbdk4.compiler import leap, save, convert, compile
from hbdk4.compiler.hbm import Hbm
torch.set_num_threads(2)


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as file:
        for block in iter(lambda: file.read(4 * 1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def metric(actual, reference):
    a, b = np.asarray(actual, dtype=np.float64), np.asarray(reference, dtype=np.float64)
    return dict(max_abs=float(np.max(np.abs(a-b))), rel_l2=float(np.linalg.norm(a-b)/max(np.linalg.norm(b), 1e-12)))


class DecoderBlock:
    def __init__(self, layer, source, packed, records):
        self.prefix = f'language_model.model.layers.{layer}.'
        self.source = source
        self.index = json.loads((source/'model.safetensors.index.json').read_text())['weight_map']
        self.linears, self.bounds, self.norm_scales = {}, {}, {}
        self.hashes = {}
        for suffix in ('self_attn.q_proj', 'self_attn.k_proj', 'self_attn.v_proj', 'self_attn.o_proj', 'mlp.gate_proj', 'mlp.up_proj', 'mlp.down_proj'):
            path = packed/(self.prefix+suffix+'.npz')
            assert digest(path) == records[str(path)]['sha256'], str(path)
            data = np.load(path)
            rows, columns = data['shape'].tolist()
            group_size = int(data['group_size'])
            assert group_size == 32
            codes, scales, zeros = data['codes'], data['scales'], data['zeros']
            bits = data['bits']
            assert set(np.unique(bits)).issubset({8,16})
            assert codes.shape == (rows, columns)
            group_index = np.arange(columns)//group_size
            dequant = (codes.astype(np.float32)-zeros[:,group_index])*scales[:,group_index]
            # The accepted CUDA candidate stores the restored weights as BF16.
            # Preserve those represented values before hardware decomposition.
            dequant = torch.from_numpy(dequant).bfloat16().float().numpy()
            high_scale = np.maximum(np.max(np.abs(dequant),axis=1)/127,1e-12).astype(np.float32)
            high_codes = np.clip(np.rint(dequant/high_scale[:,None]),-127,127).astype(np.int8)
            residual = dequant-high_codes.astype(np.float32)*high_scale[:,None]
            low_scale = np.maximum(np.max(np.abs(residual),axis=1)/127,1e-12).astype(np.float32)
            low_codes = np.clip(np.rint(residual/low_scale[:,None]),-127,127).astype(np.int8)
            represented = high_codes.astype(np.float32)*high_scale[:,None]+low_codes.astype(np.float32)*low_scale[:,None]
            initial_error = metric(represented,dequant)
            extra_codes, extra_scale = None, None
            if initial_error['rel_l2'] >= 0.0001:
                remainder = dequant-represented
                extra_scale = np.maximum(np.max(np.abs(remainder),axis=1)/127,1e-12).astype(np.float32)
                extra_codes = np.clip(np.rint(remainder/extra_scale[:,None]),-127,127).astype(np.int8)
                represented = represented+extra_codes.astype(np.float32)*extra_scale[:,None]
            error = metric(represented,dequant)
            assert error['rel_l2'] < 0.0001, error
            bias_name = self.prefix+suffix+'.bias'
            bias = self.original(bias_name) if bias_name in self.index else None
            self.linears[suffix] = dict(extra_codes=extra_codes, extra_scale=extra_scale, initial_representation_error=initial_error, high_codes=high_codes, high_scale=high_scale, low_codes=low_codes, low_scale=low_scale, weight=torch.from_numpy(dequant), represented_weight=torch.from_numpy(represented), representation_error=error, logical_int16_fraction=float((bits==16).mean()), bias=bias)
            self.hashes[suffix] = digest(path)
        self.gammas = {name: self.original(self.prefix+name+'.weight') for name in ('input_layernorm', 'post_attention_layernorm')}

    def original(self, name):
        with safe_open(str(self.source/self.index[name]), framework='pt', device='cpu') as file:
            return file.get_tensor(name).float()

    def observe(self, name, value):
        maximum = float(value.detach().abs().max())
        self.bounds[name] = max(maximum*1.25, self.bounds.get(name, 1e-8))
        return value

    def torch_forward(self, hidden, cos, sin, past_k, past_v, mask, observe=False, fp16_norm=False):
        def seen(name, value):
            return self.observe(name, value) if observe else value

        def linear(name, value):
            seen(name+'.input', value)
            p = self.linears[name]
            return seen(name+'.output', F.linear(value, p['represented_weight'], p['bias']))

        def norm(name, value):
            seen(name+'.input', value)
            if observe:
                variance = value.square().mean(-1)
                low, high = float(variance.min()), float(variance.max())
                previous = self.norm_scales.get(name, dict(low=low, high=high))
                self.norm_scales[name] = dict(low=min(low, previous['low']), high=max(high, previous['high']))
            if fp16_norm:
                factor = self.norm_scales[name]['factor']
                scaled = (value*factor).half()
                # Simulate the explicit FP16 graph, not the native BF16 model.
                variance = scaled.square().float().mean(-1, keepdim=True).half()
                inverse = torch.rsqrt(variance+1e-6*factor*factor)
                result = (scaled*inverse*self.gammas[name].half()).float()
            else:
                result = value*torch.rsqrt(value.square().mean(-1, keepdim=True)+1e-6)*self.gammas[name]
            return seen(name+'.output', result)

        length = hidden.shape[0]
        x = norm('input_layernorm', hidden)
        q, k, v = [linear('self_attn.'+name+'_proj', x).reshape(length, heads, 128).permute(1, 0, 2) for name, heads in [('q',16), ('k',2), ('v',2)]]
        def rope(t):
            rotated = torch.cat((-t[...,64:], t[...,:64]), -1)
            return t*cos+rotated*sin
        q, k = seen('rotary.q', rope(q)), seen('rotary.k', rope(k))
        v = seen('attention.v_new', v)
        keys, values = torch.cat((past_k,k),1), torch.cat((past_v,v),1)
        seen('attention.keys', keys); seen('attention.values', values)
        query = q.reshape(2,8*length,128)
        score = (query@keys.transpose(1,2)/math.sqrt(128)).reshape(16,length,keys.shape[1])+mask
        seen('attention.scores', score)
        probability = seen('attention.probability', torch.softmax(score,-1))
        attended = (probability.reshape(2,8*length,keys.shape[1])@values).reshape(16,length,128).permute(1,0,2).reshape(length,2048)
        seen('attention.attended', attended)
        residual = seen('attention.residual', hidden+linear('self_attn.o_proj',attended))
        x = norm('post_attention_layernorm',residual)
        gate = seen('mlp.swish',F.silu(linear('mlp.gate_proj',x)))
        product = seen('mlp.product',gate*linear('mlp.up_proj',x))
        output = seen('output',residual+linear('mlp.down_proj',product))
        return output, k, v

    def finalize_calibration(self):
        for name, stats in self.norm_scales.items():
            # Keep squaring and epsilon representable; power-of-two rescaling is
            # algebraically RMS invariant. Bound sum-of-squares below FP16 range.
            target = math.sqrt(0.25/max(stats['low'],1e-12))
            upper = math.sqrt(16000/(2048*max(stats['high'],1e-12)))
            factor = 2**math.floor(math.log2(max(min(target,upper),2**-12)))
            stats['factor'] = factor
        self.bounds['attention.scores'] = max(32.,self.bounds['attention.scores'])

    def build(self, hidden, cos, sin, past_k, past_v, mask):
        length=hidden.type.shape[0];past_length=past_k.type.shape[1]
        def floating(x):return leap.cast_type(x,output_type=leap.float32)
        def split(x,maximum):
            residual=floating(x);parts=[]
            for _ in range(3):
                step=float(np.float32(maximum/128))
                q=leap.const_fake_quant(leap.mul(residual,1/step),[-128.],[128.],8,True)
                represented=leap.mul(floating(q),step)
                parts.append((q,step))
                residual=floating(leap.add(residual,leap.mul(represented,-1.)))
                maximum=maximum*.55/127
            return parts
        def norm(name,value):
            variance=leap.reshape(leap.reduce_mean(leap.mul(value,value),[-1]),[length,1])
            inverse=rsqrt_positive_bpu(leap.add(variance,1e-6))
            return floating(leap.mul(leap.mul(value,inverse),self.gammas[name].reshape(1,-1)))
        def linear(name,value):
            p=self.linears[name];activations=split(value,self.bounds[name+'.input'])
            parameters=[('high_codes','high_scale'),('low_codes','low_scale')]
            if p['extra_codes'] is not None:parameters.append(('extra_codes','extra_scale'))
            outputs=[]
            for codes,scales in parameters:
                weight=leap.dequantize(torch.from_numpy(p[codes].copy()),scales=[1.]*p[codes].shape[0],zeros=[0]*p[codes].shape[0],axis=0)
                for activation,step in activations:
                    integer_dot=floating(leap.linear(activation,weight))
                    outputs.append(leap.mul(integer_dot,torch.from_numpy(p[scales]*np.float32(step))))
            total=outputs[0]
            for term in outputs[1:]:total=leap.add(total,term)
            if p['bias'] is not None:total=leap.add(total,p['bias'])
            return floating(total)
        def rope(value,heads):
            a=leap.slice(value,[0,0,0],[heads,length,64],[1,1,1]);b=leap.slice(value,[0,0,64],[heads,length,128],[1,1,1])
            rotated=leap.concat([leap.mul(b,-1.),a],-1)
            return floating(leap.add(leap.mul(value,cos),leap.mul(rotated,sin)))
        x=norm('input_layernorm',hidden)
        q=leap.transpose(leap.reshape(linear('self_attn.q_proj',x),[length,16,128]),[1,0,2])
        k=leap.transpose(leap.reshape(linear('self_attn.k_proj',x),[length,2,128]),[1,0,2])
        v=leap.transpose(leap.reshape(linear('self_attn.v_proj',x),[length,2,128]),[1,0,2])
        q,k=rope(q,16),rope(k,2)
        keys=leap.concat([past_k,k],1);values=leap.concat([past_v,v],1)
        queries=[(leap.reshape(z,[2,8*length,128]),step) for z,step in split(q,self.bounds['rotary.q'])]
        key_parts=[(leap.transpose(z,[0,2,1]),step) for z,step in split(keys,self.bounds['attention.keys'])]
        terms=[leap.mul(floating(leap.matmul(a,b)),float(np.float32(sa)*np.float32(sb))) for a,sa in queries for b,sb in key_parts]
        score=terms[0]
        for term in terms[1:]:score=leap.add(score,term)
        score=leap.reshape(leap.mul(score,1/math.sqrt(128)),[16,length,past_length+length])
        probability=softmax_float_bpu(leap.add(score,mask))
        probability=leap.reshape(probability,[2,8*length,past_length+length])
        terms=[leap.mul(floating(leap.matmul(a,b)),float(np.float32(sa)*np.float32(sb))) for a,sa in split(probability,1.) for b,sb in split(values,self.bounds['attention.values'])]
        attended=terms[0]
        for term in terms[1:]:attended=leap.add(attended,term)
        attended=leap.reshape(leap.transpose(leap.reshape(attended,[16,length,128]),[1,0,2]),[length,2048])
        residual=floating(leap.add(hidden,linear('self_attn.o_proj',attended)))
        x=norm('post_attention_layernorm',residual)
        gate_input=linear('mlp.gate_proj',x)
        maximum=self.bounds['mlp.gate_proj.output']
        sigmoid=leap.const_fake_quant(leap.sigmoid(leap.const_fake_quant(gate_input,[-maximum],[maximum],16,True)),[-1.],[1.],16,True)
        gate=leap.mul(gate_input,floating(sigmoid))
        product=floating(leap.mul(gate,linear('mlp.up_proj',x)))
        return floating(leap.add(residual,linear('mlp.down_proj',product))),k,v


def inputs(directory):
    hidden = torch.from_numpy(np.load(directory/'hidden_states.npy')[0])
    positions = torch.from_numpy(np.load(directory/'position_ids.npy')[0]).float()
    inverse = 1/(1000000**(torch.arange(0,128,2).float()/128))
    angles = positions[:,None]*inverse[None,:]
    angles = torch.cat((angles,angles),-1)
    # Original rotary table is BF16 in native reference; preserve those values
    # explicitly rather than folding a different FP32 table into this graph.
    cos,sin = angles.cos().bfloat16().float()[None],angles.sin().bfloat16().float()[None]
    past = [torch.from_numpy(np.load(directory/f'past-{i}.npy')[0]) if (directory/f'past-{i}.npy').exists() else torch.empty(2,0,128) for i in range(2)]
    path = directory/'attention_mask.npy'
    if path.exists():
        mask = torch.from_numpy(np.load(path)[0])
        mask = torch.where(mask < -10000,torch.tensor(-1024.),mask)
    else:
        assert hidden.shape[0] == 1, 'Missing mask only valid for native single-token AR call'
        mask = torch.zeros(1,1,past[0].shape[1]+1)
    return hidden,cos,sin,*past,mask


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--out',required=True)
    parser.add_argument('--packed',type=Path,required=True)
    parser.add_argument('--candidate-report',type=Path,required=True)
    parser.add_argument('--layer',type=int,default=0)
    parser.add_argument('--call',type=int,default=1)
    parser.add_argument('--image',type=int,default=9)
    parser.add_argument('--sequence-size',type=int)
    parser.add_argument('--past-capacity',type=int)
    parser.add_argument('--reuse-calibration',type=Path)
    parser.add_argument('--convert-only',action='store_true')
    parser.add_argument('--mode',choices=['slow','hybrid'],default='slow')
    parser.add_argument('--capture-root',type=Path)
    parser.add_argument('--capture-precision',choices=['bf16','fp16'],default='fp16')
    args=parser.parse_args()
    assert 0<=args.layer<36
    if args.capture_root is None:assert args.layer==0,'Other layers require actual all-layer captures'
    assert args.capture_root is not None,'Require selected-checkpoint calibration profiles'
    captured_status=json.loads((args.capture_root/'status.json').read_text())
    assert captured_status['status']=='completed' and captured_status['calibration_images']==32
    def case_root(image,mode):
        matches=[x for x in captured_status['cases'] if x['image_id']==image and x['generation_mode']==mode]
        assert len(matches)==1
        directory=Path(matches[0]['directory']);assert directory.is_relative_to(args.capture_root)
        return directory
    calibration_cases=captured_status['cases']
    selected=case_root(args.image,args.mode)/f'block{args.layer}-call-{args.call}'
    target_length=inputs(selected)[0].shape[0]
    out=Path(args.out);out.mkdir(parents=True,exist_ok=False)
    report=dict(status='preparing',whole_model_verified=False,scope='One full original decoder block, all seven selected mixed-precision linears plus norms/RoPE/GQA/cache/mask/SwiGLU/residuals',started=time.time(),layer=args.layer)
    def persist():
        temp=out/'status.json.tmp';temp.write_text(json.dumps(report,indent=2));temp.replace(out/'status.json')
    persist()
    try:
        candidate=json.loads(args.candidate_report.read_text())
        assert candidate['status']=='completed' and len(candidate['modules'])==252
        records={x['packed_file']:x for x in candidate['modules']}
        block=DecoderBlock(args.layer,Path('/opt/locate-original-weights'),args.packed,records)
        report['candidate_quality_pc']=candidate['heldout_aggregate']
        report['normalization_engine']='Positive power-of-four normalized INT16 Rsqrt seed and F32 refinement, robust across padded profiles'
        report['activation_representation']='Unit-scale INT8 neural dots over3 activation and2/3 weight branches; explicit FLOAT32 rescale after every learned/dynamic dot. F32 residual/vector math, normalized Rsqrt and polynomial softmax with centered cutoff-32. No CPU inference.'
        report['weight_representation']={name:dict(error=p['representation_error'],initial_error=p['initial_representation_error'],int8_branches=2+int(p['extra_codes'] is not None),logical_int16_fraction=p['logical_int16_fraction']) for name,p in block.linears.items()}
        report['profile_limit']='One complete layer/profile;32 selected-checkpoint calibration images, distinct from regression/final images; not whole-model acceptance'
        report['actual_capture_oracle_parity']=[]
        if args.reuse_calibration is not None:
            previous=json.loads(args.reuse_calibration.read_text())
            assert previous['status']=='compiled_bpu_only' and previous['layer']==args.layer
            assert previous['packed_hashes']==block.hashes
            assert len(previous['calibration'])==192 and len(previous['actual_capture_oracle_parity'])==192
            assert all(x['max_abs']<.001 and x['rel_l2']<1e-5 for x in previous['actual_capture_oracle_parity'])
            expected={str(Path(c['directory'])/f'block{args.layer}-call-{i}') for c in calibration_cases for i in range(3)}
            assert {x['path'] for x in previous['calibration']}==expected
            block.bounds=previous['bounds'];block.norm_scales=previous['norm_scales']
            for key in ['calibration','bounds','norm_scales','packed_hashes','original_mask_equivalence','actual_capture_oracle_parity']:report[key]=previous[key]
            report['calibration_reused_from_sha256']=digest(args.reuse_calibration)
            report['calibration_is_tuning_not_unseen']=True
        else:
            calibration=[]
            original_mask_equivalence=[]
            for case in calibration_cases:
                root=case_root(case['image_id'],case['generation_mode'])
                for directory in sorted(root.glob(f'block{args.layer}-call-*')):
                    data=inputs(directory)
                    with torch.no_grad():
                        actual=block.torch_forward(*data,observe=True)
                        if (directory/'hidden_output.npy').exists():
                            captured=np.load(directory/'hidden_output.npy')[0]
                            actual_match=metric(actual[0].numpy(),captured)
                            report['actual_capture_oracle_parity'].append(dict(path=str(directory),**actual_match))
                            assert actual_match['max_abs']<.001 and actual_match['rel_l2']<1e-5, ('Actual selected-F32 decoder layer oracle mismatch',directory,actual_match)
                        if (directory/'attention_mask.npy').exists():
                            original_mask=torch.from_numpy(np.load(directory/'attention_mask.npy')[0])
                            expected=block.torch_forward(*data[:-1],original_mask)
                            changes=[metric(a.numpy(),b.numpy()) for a,b in zip(actual,expected)]
                            assert all(c['max_abs']<.001 and c['rel_l2']<1e-5 for c in changes), changes
                            original_mask_equivalence.append(dict(path=str(directory),changes=changes))
                    calibration.append(dict(path=str(directory),sequence=data[0].shape[0],past=data[3].shape[1],mode=case['generation_mode']))
            block.finalize_calibration()
            report.update(calibration=calibration,calibration_is_tuning_not_unseen=True,bounds=block.bounds,norm_scales=block.norm_scales,packed_hashes=block.hashes,original_mask_equivalence=original_mask_equivalence)
        directory=selected
        data=inputs(directory)
        if data[3].shape[1]==0:
            # Nash graph inputs cannot have zero dimensions. A zero dummy cache
            # slot is completely masked; emitted new K/V contain real tokens only.
            with torch.no_grad(): original_empty=block.torch_forward(*data)
            data=(*data[:3],torch.zeros(2,1,128),torch.zeros(2,1,128),F.pad(data[-1],(1,0),value=-1024.))
            with torch.no_grad(): padded=block.torch_forward(*data)
            report['empty_cache_equivalence']=[metric(a.numpy(),b.numpy()) for a,b in zip(padded,original_empty)]
            assert all(x['rel_l2']<1e-5 and x['max_abs']<.001 for x in report['empty_cache_equivalence'])
            report['masked_dummy_cache_slots']=1
        if args.sequence_size is not None or args.past_capacity is not None:
            original=data
            length=original[0].shape[0];past_length=original[3].shape[1]
            padded_length=args.sequence_size or length;padded_past=args.past_capacity or past_length
            assert length<=padded_length<=256 and past_length<=padded_past<=512
            hidden=F.pad(original[0],(0,0,0,padded_length-length))
            cos=F.pad(original[1],(0,0,0,padded_length-length),value=1.)
            sin=F.pad(original[2],(0,0,0,padded_length-length),value=0.)
            pk=F.pad(original[3],(0,0,0,padded_past-past_length))
            pv=F.pad(original[4],(0,0,0,padded_past-past_length))
            attention=torch.full((1,padded_length,padded_past+padded_length),-1024.)
            attention[:,:length,:past_length]=original[5][:,:,:past_length]
            attention[:,:length,padded_past:padded_past+length]=original[5][:,:,past_length:]
            attention[:,length:,0]=0.
            data=(hidden,cos,sin,pk,pv,attention)
            with torch.no_grad():
                a=block.torch_forward(*data);b=block.torch_forward(*original)
            report['padded_profile_equivalence']=[metric(x[:,:length].numpy() if i else x[:length].numpy(),y.numpy()) for i,(x,y) in enumerate(zip(a,b))]
            assert all(x['max_abs']<.001 and x['rel_l2']<1e-5 for x in report['padded_profile_equivalence'])
            report['actual_valid_sequence']=length;report['actual_valid_past']=past_length
        with torch.no_grad():reference=block.torch_forward(*data)
        names=('hidden','cos','sin','past_k','past_v','mask')
        for name,value in zip(names,data):np.save(out/(name+'.npy'),value.numpy())
        for i,value in enumerate(reference):np.save(out/f'reference_fp32-{i}.npy',value.numpy())
        module=leap.leap_export(block.build,*[leap.TensorType(list(value.shape),leap.float32) for value in data],name='locate_decoder_block').module
        save(module,str(out/'export.bc'))
        report.update(status='converting',input_shapes=[list(x.shape) for x in data]);persist()
        lowered=convert(module,'nash-m',advice=True,advice_path=str(out/'advice'))
        save(lowered,str(out/'quantized.bc'))
        function=lowered[0]
        outputs=list(function.feed({port.name:value.numpy() for port,value in zip(function.inputs,data)}).values())
        for i,value in enumerate(outputs):np.save(out/f'reference_compiled-{i}.npy',value)
        report['compiled_vs_fp32']=[metric(a,b.numpy()) for a,b in zip(outputs,reference)]
        (out/'ports.json').write_text(json.dumps({'inputs':[{'name':p.name,'file':n+'.npy'} for p,n in zip(function.inputs,names)],'outputs':[{'name':p.name,'file':f'reference_compiled-{i}.npy','fp32_file':f'reference_fp32-{i}.npy'} for i,p in enumerate(function.outputs)]},indent=2))
        if args.convert_only:
            report.update(status='converted_needs_full_quality_and_placement',compiled_bc_sha256=digest(out/'quantized.bc'))
            report['finished']=time.time();persist();return
        report.update(status='compiling',compiled_bc_sha256=digest(out/'quantized.bc'));persist()
        compile(lowered,str(out/'model.hbm'),march='nash-m',opt=0,jobs=2)
        graph=Hbm(str(out/'model.hbm')).graphs[0]
        nodes=[dict(name=node.name,device=str(node.device)) for node in graph.nodes]
        report.update(nodes=nodes,hbm_sha256=digest(out/'model.hbm'),hbm_bytes=(out/'model.hbm').stat().st_size)
        if not nodes or any('bpu' not in node['device'].lower() for node in nodes):
            report.update(status='rejected_cpu_fallback',bpu_only=False)
        else:
            report.update(status='compiled_bpu_only',bpu_only=True,board_verified=False)
    except BaseException:
        report.update(status='failed',error=traceback.format_exc())
        print(report['error'],flush=True)
    report['finished']=time.time();persist()


if __name__=='__main__':
    signal.signal(signal.SIGALRM,lambda *a:(_ for _ in ()).throw(RuntimeError('3600-second complete-layer bound')))
    signal.alarm(3600)
    main()
