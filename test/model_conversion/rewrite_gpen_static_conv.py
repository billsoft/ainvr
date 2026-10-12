"""GPEN batch-one modulated convolutions: Conv(x*s,W)*d == Conv(x,W*s*d).

Preserves original style and demodulation calculations, changes only where
channel scaling is applied. Floating-point equivalence must be validated.
Original model is read-only. No calibration or deployment is performed.
"""
import argparse
import copy
import hashlib
import json
from pathlib import Path
import numpy as np
import onnx
from onnx import helper, numpy_helper

p=argparse.ArgumentParser(description=__doc__)
p.add_argument('--source',type=Path,required=True)
p.add_argument('--output',type=Path,required=True)
a=p.parse_args();assert not a.output.exists()
digest=hashlib.sha256(a.source.read_bytes()).hexdigest()
assert digest=='bf7c7ced8e5f69fca6a3a226023a65f8f0689ae9c7d2e095b29c8c78dc3c6bb5'
m=onnx.load(str(a.source)); producers={x:n for n in m.graph.node for x in n.output}
initializers={x.name:x for x in m.graph.initializer}
new=[];changed=[]
for n in m.graph.node:
    if n.op_type not in ('Conv','ConvTranspose') or n.input[1] in initializers:
        new.append(n);continue
    assert n.name.startswith('/generator/'),n.name
    assert len(n.input) in (2,3) and len(n.output)==1,n.name
    assert next((helper.get_attribute_value(x) for x in n.attribute if x.name=='group'),1)==1
    reshape=producers[n.input[1]];assert reshape.op_type=='Reshape'
    weight=producers[reshape.input[0]]
    if n.op_type=='ConvTranspose':
        assert weight.op_type=='Transpose'
        assert helper.get_attribute_value(weight.attribute[0])==[0,2,1,3,4]
        weight=producers[weight.input[0]]
    assert weight.op_type=='Mul'
    demod=None
    if weight.name.endswith('/Mul_1'):
        demod=producers[weight.input[1]];assert demod.op_type=='Reshape'
        weight=producers[weight.input[0]]
    if demod is not None:assert len(n.input)==2,n.name
    assert weight.op_type=='Mul' and weight.input[0] in initializers
    base=numpy_helper.to_array(initializers[weight.input[0]])
    assert base.ndim==5 and base.shape[0]==1 and base.dtype==np.float32
    out_ch,in_ch=base.shape[1:3]
    style=producers[weight.input[1]];assert style.op_type=='Reshape'
    prefix=n.name+'/ainvr_static'
    style_shape=prefix+'_style_shape';style_out=prefix+'_style';scaled=prefix+'_scaled_input'
    const_weight=prefix+'_weight'
    m.graph.initializer.extend([
        numpy_helper.from_array(np.array([1,in_ch,1,1],dtype=np.int64),style_shape),
        numpy_helper.from_array(base[0].transpose(1,0,2,3).copy() if n.op_type=='ConvTranspose' else base[0].copy(),const_weight)])
    new.extend([helper.make_node('Reshape',[style.input[0],style_shape],[style_out],name=prefix+'/Style'),
                helper.make_node('Mul',[n.input[0],style_out],[scaled],name=prefix+'/ScaleInput')])
    conv=copy.deepcopy(n);conv.input[0]=scaled;conv.input[1]=const_weight
    if demod is not None:
        conv.output[0]=prefix+'_conv_output'
        dshape=prefix+'_demod_shape';dout=prefix+'_demod'
        m.graph.initializer.append(numpy_helper.from_array(np.array([1,out_ch,1,1],dtype=np.int64),dshape))
        new.extend([conv,helper.make_node('Reshape',[demod.input[0],dshape],[dout],name=prefix+'/Demod'),
                    helper.make_node('Mul',[conv.output[0],dout],list(n.output),name=prefix+'/ScaleOutput')])
    else:new.append(conv)
    changed.append({'name':n.name,'op_type':n.op_type,'input_channels':int(in_ch),'output_channels':int(out_ch),'demodulated':demod is not None})
assert len(changed)==20,len(changed)
# Remove weight reshapes which are no longer consumed, keep demod calculation.
needed={x.name for x in m.graph.output};kept=[]
for n in reversed(new):
    if any(x in needed for x in n.output):kept.append(n);needed.update(n.input)
del m.graph.node[:];m.graph.node.extend(reversed(kept))
used={x for n in m.graph.node for x in n.input}
keep_init=[x for x in m.graph.initializer if x.name in used]
del m.graph.initializer[:];m.graph.initializer.extend(keep_init)
del m.graph.value_info[:]
onnx.checker.check_model(m)
onnx.save(m,str(a.output))
assert hashlib.sha256(a.source.read_bytes()).hexdigest()==digest
report={'source_sha256':digest,'source_unchanged':True,'output_sha256':hashlib.sha256(a.output.read_bytes()).hexdigest(),
        'rewritten_convolutions':changed,'fp32_parity_verified':False,'production_approved':False}
a.output.with_suffix('.rewrite.json').write_text(json.dumps(report,indent=2))
print(json.dumps({'changed':len(changed),'nodes':len(m.graph.node),'sha256':report['output_sha256']}))
