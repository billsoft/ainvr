#!/usr/bin/env python3
"""AINVR uploaded-model inventory; never unpickles PT/PTH checkpoints."""
import argparse,collections,hashlib,json,pickletools,struct,zipfile
from pathlib import Path

def inspect(path):
    before=path.stat()
    result={'file':str(path),'bytes':before.st_size}
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(8*1024*1024),b''):h.update(block)
    after=path.stat();stable=(before.st_size,before.st_mtime_ns)==(after.st_size,after.st_mtime_ns)
    result['sha256']=h.hexdigest() if stable else None
    result['stable_during_hash']=stable
    if path.suffix=='.onnx':
        import onnx
        model=onnx.load(str(path),load_external_data=True)
        def tensor(t):
            v=t.type.tensor_type
            return {'name':t.name,'dtype':onnx.TensorProto.DataType.Name(v.elem_type),'shape':[d.dim_value if d.HasField('dim_value') else d.dim_param or '?' for d in v.shape.dim]}
        result.update(producer=model.producer_name,producer_version=model.producer_version,ir_version=model.ir_version,
            opsets={x.domain:x.version for x in model.opset_import},inputs=[tensor(x) for x in model.graph.input],outputs=[tensor(x) for x in model.graph.output],
            operators=dict(collections.Counter((n.domain+':' if n.domain else '')+n.op_type for n in model.graph.node)),
            initializer_dtypes=dict(collections.Counter(onnx.TensorProto.DataType.Name(x.data_type) for x in model.graph.initializer)),
            metadata={x.key:x.value for x in model.metadata_props})
        try:onnx.checker.check_model(model,full_check=True);result['onnx_checker']='PASS'
        except Exception as e:result['onnx_checker']='FAIL';result['checker_error']=str(e)[:2000]
    elif path.suffix in ('.pt','.pth','.ts'):
        result['archive']='zip' if zipfile.is_zipfile(path) else 'legacy/unknown'
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as z:
                names=z.namelist();result['torchscript']=any('/code/' in n for n in names)
                result['globals']=[]
                for name in names:
                    if name.endswith('data.pkl') and z.getinfo(name).file_size<20*1024*1024:
                        try:result['globals']=sorted({arg for op,arg,pos in pickletools.genops(z.read(name)) if op.name=='GLOBAL'})
                        except Exception as e:result['pickle_scan_error']=str(e)
    elif path.suffix=='.safetensors':
        with path.open('rb') as f:
            size=struct.unpack('<Q',f.read(8))[0]
            if size>32*1024*1024:raise ValueError('Invalid safetensors header size')
            header=json.loads(f.read(size))
        expected=8+size+max(v['data_offsets'][1] for k,v in header.items() if k!='__metadata__')
        result['expected_file_bytes']=expected
        result['file_length_matches_header']=path.stat().st_size==expected
        result['tensor_count']=len(header)-('__metadata__' in header)
        result['tensor_samples']={k:v for k,v in list(header.items())[:8]}
    return result

def main():
    p=argparse.ArgumentParser();p.add_argument('directory',type=Path);p.add_argument('--output',type=Path,required=True);a=p.parse_args();a.output.mkdir(parents=True,exist_ok=True)
    records=[]
    for path in sorted(a.directory.rglob('*')):
        if not path.is_file() or path.suffix not in ('.onnx','.pt','.pth','.ts','.safetensors'):continue
        try:r=inspect(path)
        except Exception as e:r={'file':str(path),'error':str(e)}
        records.append(r);(a.output/'inventory.json').write_text(json.dumps(records,indent=2,ensure_ascii=False),encoding='utf-8')
        print(json.dumps({k:v for k,v in r.items() if k in ('file','onnx_checker','inputs','outputs','error','globals','torchscript','tensor_count')},ensure_ascii=False),flush=True)
if __name__=='__main__':main()
