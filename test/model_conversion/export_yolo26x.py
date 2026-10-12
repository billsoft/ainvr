#!/usr/bin/env python3
"""AINVR test-only official YOLO26x PT -> ONNX with real-frame numerical parity.

Outputs are SSD conversion candidates. No CPU production inference is enabled.
HBM compilation, calibration quality and BPU performance remain separate gates.
"""
import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import time


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for data in iter(lambda: f.read(1024 * 1024), b''):
            h.update(data)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--task', choices=['coco80', 'face'], default='coco80')
    p.add_argument('--source', type=Path)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--image-f32', type=Path, action='append', required=True)
    args = p.parse_args()
    model_name = 'yolo26x-face' if args.task == 'face' else 'yolo26x'
    expected_classes = 1 if args.task == 'face' else 80
    pinned_sha = ('77b67f724d6699669927c8d0287f8d56b1066da63e2ef14b8c4ae11677074678'
                  if args.task == 'face' else
                  '9fdd44a31c504547ffb81d2c6d9e6dac3493c8eaa8b0398d3f43bae6c7003e92')
    source = (args.source or Path('/mnt/ainvr-ssd/model-sources/ainvr-20261012/models') / (model_name + '.pt')).resolve(strict=True)
    if digest(source) != pinned_sha:
        raise RuntimeError('Pinned model source required')
    out = args.output.resolve()
    if not Path('/mnt/ainvr-ssd').is_mount() or not out.is_relative_to(Path('/mnt/ainvr-ssd')):
        p.error('New output must be on mounted SSD')
    out.mkdir(parents=True, exist_ok=False)
    cfg = out / 'config'
    (cfg / 'Ultralytics').mkdir(parents=True)
    os.environ['YOLO_CONFIG_DIR'] = str(cfg)
    os.environ['YOLO_AUTOINSTALL'] = 'false'
    source_hash = digest(source)
    report = {'passed': False, 'model': model_name, 'source': str(source),
              'source_sha256': source_hash, 'test_only_cpu_oracle': True,
              'hbm_compiled': False, 'detection_accuracy_verified': False,
              'production_inference_verified': False}
    started = time.monotonic()
    try:
        import numpy as np
        import torch
        import ultralytics
        import onnx
        import onnxruntime as ort
        from scipy.optimize import linear_sum_assignment
        from ultralytics import YOLO
        if ultralytics.__version__ != '8.4.142' or torch.__version__.split('+')[0] != '2.9.0':
            raise RuntimeError('Locked Ultralytics 8.4.142 and torch 2.9.0 required')
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        model = YOLO(str(source)).model.cpu().float().eval()
        names = model.names
        if isinstance(names, dict):
            if set(names) != set(range(expected_classes)):
                raise RuntimeError('Unexpected class IDs')
            names = [names[i] for i in range(expected_classes)]
        expected_first_name = 'face' if args.task == 'face' else 'person'
        if len(names) != expected_classes or names[0] != expected_first_name:
            raise RuntimeError('Unexpected class vocabulary: ' + str(names))
        head = model.model[-1]
        head.end2end = True
        if not head.end2end:
            raise RuntimeError('Official one-to-one detection head unavailable')
        head.export, head.format, head.dynamic = True, 'onnx', False
        head.max_det = 300
        for parameter in model.parameters():
            parameter.requires_grad_(False)
        images = []
        for path in args.image_f32:
            path = path.resolve(strict=True)
            data = np.fromfile(path, dtype='<f4')
            if data.size != 3 * 640 * 640 or not np.isfinite(data).all() or data.min() < 0 or data.max() > 1:
                raise RuntimeError('Invalid hardware-preprocessed normalized RGB NCHW tensor')
            images.append((path, data.reshape(1, 3, 640, 640)))
        graph_path = out / (model_name + '.onnx')
        with torch.inference_mode():
            expected = [model(torch.from_numpy(image)).numpy() for _, image in images]
            if any(output.shape != (1, 300, 6) for output in expected):
                raise RuntimeError('Unexpected end-to-end detection output shape')
            torch.onnx.export(model, (torch.from_numpy(images[0][1]),), str(graph_path),
                              input_names=['images'], output_names=['output0'],
                              opset_version=17, dynamo=False, do_constant_folding=True)
        graph = onnx.load(str(graph_path))
        onnx.checker.check_model(graph, full_check=True)
        options = ort.SessionOptions()
        options.intra_op_num_threads, options.inter_op_num_threads = 2, 1
        session = ort.InferenceSession(str(graph_path), sess_options=options, providers=['CPUExecutionProvider'])
        parity = []
        for (path, image), ref in zip(images, expected):
            value = session.run(None, {'images': image})[0]
            if value.shape != (1, 300, 6) or not np.isfinite(value).all():
                raise RuntimeError('Invalid exported detection output')
            if (value[:, :, 4].min() < 0 or value[:, :, 4].max() > 1
                    or value[:, :, 5].min() < 0 or value[:, :, 5].max() >= expected_classes
                    or not np.array_equal(value[:, :, 5], np.round(value[:, :, 5]))):
                raise RuntimeError('Invalid score/class output')
            # TopK rows are score ranked. Near-equal scores may exchange rank
            # between frameworks, so compare the complete detection set with
            # a bijection, retaining exact class and strict box/score checks.
            reference, actual = ref[0], value[0]
            costs = np.max(np.abs(reference[:, None, :4] - actual[None, :, :4]), axis=2)
            costs += (reference[:, None, 5] != actual[None, :, 5]) * 1e6
            rows, columns = linear_sum_assignment(costs)
            aligned = actual[columns]
            np.testing.assert_array_equal(rows, np.arange(300))
            np.testing.assert_array_equal(aligned[:, 5], reference[:, 5])
            np.testing.assert_allclose(aligned[:, :4], reference[:, :4], rtol=0.002, atol=0.002)
            np.testing.assert_allclose(aligned[:, 4], reference[:, 4], rtol=0.002, atol=1e-6)
            delta = np.abs(aligned - reference)
            parity.append({'image_source': str(path), 'image_sha256': digest(path),
                           'max_abs_error': float(delta.max()), 'mean_abs_error': float(delta.mean()),
                           'comparison': 'complete_detection_set_bijection',
                           'reordered_rows': int(np.count_nonzero(columns != rows)),
                           'max_score_abs_error': float(delta[:, 4].max())})
        report.update({'passed': True, 'class_names': names, 'class_count': expected_classes,
                       'onnx_path': str(graph_path), 'onnx_sha256': digest(graph_path),
                       'input_shape': [1, 3, 640, 640], 'output_shape': [1, 300, 6],
                       'output_layout': 'end2end_xyxy_score_class', 'parity': parity,
                       'operators': dict(Counter(node.op_type for node in graph.graph.node)),
                       'versions': {'ultralytics': ultralytics.__version__, 'torch': torch.__version__}})
    except Exception as exc:
        report['error'] = type(exc).__name__ + ': ' + str(exc)
        raise
    finally:
        report['source_unchanged'] = digest(source) == source_hash
        report['elapsed_seconds'] = time.monotonic() - started
        if not report['source_unchanged']:
            report['passed'] = False
        (out / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
