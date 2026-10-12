"""Prepare a bounded YOLO26x precision experiment in an official OE container.

Keep convolutions INT8. Coordinate/score assembly must not share an integer
scale: a ~800-pixel box and a <1 confidence lose the confidence at INT8.
This creates a candidate configuration only. Placement and real-board output
validation remain mandatory; float configuration alone proves no backend.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--config', type=Path, required=True)
    p.add_argument('--optimized-model', type=Path, required=True)
    p.add_argument('--output-directory', type=Path, required=True)
    p.add_argument('--prefix', required=True)
    a = p.parse_args()
    assert re.fullmatch(r'[A-Za-z0-9_-]+', a.prefix)
    import onnx
    config = json.loads(a.config.read_text())
    assert config['model_parameters']['march'] == 'nash-m'
    source = Path(config['model_parameters']['onnx_model'])
    source_sha = hashlib.sha256(source.read_bytes()).hexdigest()
    assert source_sha in {
        '0d66522c8cdbe17948a7f5f3a1c3de53b5aeb9a69abac23bf147d38de0de4c10',
        '9fdd59c45d73f42df9b39038efaf2dfa8338991dba24e99e65ad25884b43b799',
    }, 'This experiment is scoped to the verified YOLO26x exports'
    model = onnx.load(a.optimized_model)
    names = {n.name for n in model.graph.node}
    float_nodes = [
        '/model.23/Concat_3', '/model.23/Transpose',
        '/model.23/Split', '/model.23/Concat_4',
    ]
    assert all(name in names for name in float_nodes + ['/model.23/Cast'])
    calibration = Path(config['calibration_parameters']['cal_data_dir'])
    inputs = list(calibration.glob('*.bin'))
    assert len(inputs) == 512
    assert all(path.stat().st_size == 3 * 640 * 640 * 4 for path in inputs)
    quant = config['calibration_parameters']['quant_config']
    quant['model_config'] = {
        'all_node_type': 'int8', 'activation': {'calibration_type': 'max'},
    }
    quant['op_config'] = {
        name: {'qtype': 'int16'} for name in ['HzSwish', 'Mul', 'Add', 'Sub']
    }
    quant['node_config'] = {
        node.name: {'qtype': 'int16'} for node in model.graph.node
        if node.name.startswith('/model.23/')
        and node.op_type not in ['Conv', 'Constant', 'Mod', 'Div', 'Cast']
    }
    for name in float_nodes:
        quant['node_config'][name] = {'qtype': 'float32', 'output': 'float32'}
    quant['node_config']['/model.23/Cast'] = {'output': 'float32'}
    destination = a.output_directory.resolve()
    destination.mkdir(exist_ok=False)
    config['model_parameters']['working_dir'] = str(destination / 'model_output')
    config['model_parameters']['output_model_file_prefix'] = a.prefix
    config['compiler_parameters'].update(optimize_level='O0', jobs=1)
    target = destination / 'candidate.yaml'
    target.write_text(json.dumps(config, indent=2))
    assert hashlib.sha256(source.read_bytes()).hexdigest() == source_sha
    (destination / 'experiment.json').write_text(json.dumps({
        'source_onnx_sha256': source_sha, 'source_unchanged': True,
        'optimized_model_sha256': hashlib.sha256(a.optimized_model.read_bytes()).hexdigest(),
        'configuration_sha256': hashlib.sha256(target.read_bytes()).hexdigest(),
        'calibration_samples': 512, 'mixed_assembly_nodes': float_nodes,
        'placement_verified': False, 'accuracy_verified': False,
        'production_approved': False,
    }, indent=2))
    print(target)


if __name__ == '__main__':
    main()
