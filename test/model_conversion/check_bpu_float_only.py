"""AINVR: bounded S100P floating-only compilation feasibility probes."""
import json
import subprocess
from pathlib import Path

root = Path('/data/bpu-float-only-20261012')
root.mkdir(exist_ok=False)
results = []
for name, source in [('yolo26x-face', 'yolo26x-face-op17'), ('gpen256', 'gpen256')]:
    run = root / name
    run.mkdir()
    config = {
        'model_parameters': {'onnx_model': f'/models/{source}.onnx', 'march': 'nash-m',
                             'output_model_file_prefix': name.replace('-', '_') + '_fp16',
                             'working_dir': str(run / 'output')},
        'input_parameters': {'input_type_train': 'featuremap', 'input_type_rt': 'featuremap'},
        'calibration_parameters': {'quant_config': {'model_config': {'all_node_type': 'float16'}}},
        'compiler_parameters': {'compile_mode': 'latency', 'optimize_level': 'O0', 'jobs': 4}}
    path = run / 'candidate.yaml'
    path.write_text(json.dumps(config, indent=2))
    with (run / 'compile.log').open('w') as log:
        result = subprocess.run(['timeout', '180', 'hb_compile', '--config', str(path)],
                                stdout=log, stderr=subprocess.STDOUT)
    item = {'model': name, 'exit_code': result.returncode,
            'hbm_files': [str(p) for p in run.rglob('*.hbm')],
            'requested_precision': 'float16', 'production_approved': False,
            'board_fps': None}
    results.append(item)
    (root / 'summary.json').write_text(json.dumps(results, indent=2))
    print(json.dumps(item), flush=True)
