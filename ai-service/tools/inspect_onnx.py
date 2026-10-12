#!/usr/bin/env python3
"""AINVR: validate an exported ONNX on the model-conversion host."""
import argparse
import hashlib
import json
from pathlib import Path

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('model',type=Path)
    parser.add_argument('--report',type=Path,required=True)
    args=parser.parse_args()
    import onnx
    model=onnx.load(str(args.model),load_external_data=True)
    onnx.checker.check_model(model,full_check=True)
    def tensor(value):
        typ=value.type.tensor_type
        return {'name':value.name,'element_type':typ.elem_type,
                'shape':[d.dim_value if d.HasField('dim_value') else d.dim_param for d in typ.shape.dim]}
    report={'model':str(args.model),'sha256':hashlib.sha256(args.model.read_bytes()).hexdigest(),
            'target':'nash-m','inputs':[tensor(x) for x in model.graph.input],
            'outputs':[tensor(x) for x in model.graph.output],
            'opsets':{x.domain:x.version for x in model.opset_import},
            'operators':sorted({(x.domain+':'+x.op_type) for x in model.graph.node}),
            'status':'onnx_valid; compiler support, calibration and accuracy not yet verified'}
    args.report.write_text(json.dumps(report,indent=2),encoding='utf-8')
if __name__=='__main__':main()
