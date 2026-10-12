"""AINVR fixed-length, variable-token text ONNX preparation, offline only."""
import argparse,hashlib,json,time
from pathlib import Path
import numpy as np
import torch
import onnx
import onnxruntime as ort
p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--encoder',type=Path,required=True)
p.add_argument('--prompt-samples',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();a.output.mkdir(exist_ok=False);torch.set_num_threads(2)
r={'state':'exporting','started_unix':time.time(),'source_sha256':hashlib.sha256(a.encoder.read_bytes()).hexdigest(),'production_approved':False,'BPU_verified':False,'scope':'Offline original MobileCLIP2 text encoder ONNX, before YOLOE RepRTA'}
def save(): (a.output/'status.json').write_text(json.dumps(r,indent=2))
save()
try:
    m=torch.jit.load(str(a.encoder),map_location='cpu').eval().float()
    first=np.load(next(a.prompt_samples.glob('prompts-*.npz')))['tokens'][:1]
    t=torch.from_numpy(first.astype('int64'))
    # This frozen checkpoint has fixed width 512 and 12 packed QKV projections.
    # PyTorch 2.6's generic unflatten exporter loses rank before transpose.
    # Preserve the same reshape while annotating its rank for fixed batch=1,
    # context=77. The token values remain an input; no text is frozen here.
    assert a.encoder.name=='mobileclip2_b.ts'
    from torch.onnx import symbolic_helper
    def packed_unflatten(g, value, dim, sizes):
        assert symbolic_helper._get_const(dim,'i','dim')==-1
        out=g.op('Reshape',value,g.op('Constant',value_t=torch.tensor([77,1,3,512],dtype=torch.long)))
        return out.setType(value.type().with_sizes([77,1,3,512]))
    torch.onnx.register_custom_op_symbolic('aten::unflatten',packed_unflatten,17)
    r['export_repair']='Fixed packed-QKV unflatten rank annotation, verified against original TorchScript tokens; not a model-weight rewrite'
    model=a.output/'mobileclip2-text-tokens77.onnx'
    torch.onnx.export(m,(t,),str(model),input_names=['tokens'],output_names=['text_embedding'],opset_version=17,do_constant_folding=True,dynamo=False)
    graph=onnx.load(str(model))
    # CLIP locates EOT using ArgMax on token IDs. This ORT build has no integer
    # ArgMax kernel. IDs 0..49407 are exactly representable in float32, so this
    # cast is exact integer-index logic, not floating approximation of tokens.
    nodes=[]; repairs=0
    for node in graph.graph.node:
        if node.op_type=='ArgMax':
            assert list(node.input)==['tokens']
            cast=onnx.helper.make_node('Cast',['tokens'],['tokens_exact_fp32_for_eot'],name='exact_token_cast_for_eot',to=onnx.TensorProto.FLOAT)
            nodes.append(cast);node.input[0]='tokens_exact_fp32_for_eot';repairs+=1
        nodes.append(node)
    assert repairs==1
    del graph.graph.node[:];graph.graph.node.extend(nodes)
    r['index_export_repair']='Token-ID EOT ArgMax uses exact fp32 cast; allowed IDs 0..49407'
    onnx.checker.check_model(graph);onnx.save(graph,str(model))
    inputs={x.name:[d.dim_value for d in x.type.tensor_type.shape.dim] for x in graph.graph.input}
    assert inputs=={'tokens':[1,77]}
    opts=ort.SessionOptions();opts.intra_op_num_threads=2;opts.inter_op_num_threads=1
    session=ort.InferenceSession(str(model),opts,providers=['CPUExecutionProvider']);errors=[];cases=0
    for sample in sorted(a.prompt_samples.glob('prompts-*.npz')):
        for tokens in np.load(sample)['tokens']:
            tokens=np.ascontiguousarray(tokens.reshape(1,77),dtype='int64')
            with torch.no_grad():ref=m(torch.from_numpy(tokens)).numpy()
            got=session.run(None,{'tokens':tokens})[0];assert got.shape==ref.shape==(1,512) and np.isfinite(got).all()
            error=float(np.max(np.abs(got-ref)));assert error<1e-4;errors.append(error);cases+=1
    assert cases==4
    r.update(state='onnx_reference_verified',inputs=inputs,output_shape=[1,512],maximum_error=max(errors),real_token_sequences=cases,onnx_sha256=hashlib.sha256(model.read_bytes()).hexdigest(),op_types=sorted(set(x.op_type for x in graph.graph.node)))
except Exception as e:r.update(state='failed',error=repr(e));raise
finally:r['finished_unix']=time.time();save()
print(json.dumps(r,indent=2),flush=True)
