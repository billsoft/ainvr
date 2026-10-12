#!/usr/bin/env python3
"""AINVR test-only PT/TorchScript export; never enables CPU production inference.

Run under a bounded supervisor. Source weights are read-only; outputs are new
SSD test artifacts, not production HBM models. YOLOE keeps raw CLIP embeddings
as an explicit runtime input and retains mask outputs. Prompt count is fixed
at one, matching the reference service's one-description request contract.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import time


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--kind', choices=['yoloe', 'text-encoder'], required=True)
    p.add_argument('--source', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--image-f32', type=Path)
    args = p.parse_args()
    source = args.source.resolve(strict=True)
    out = args.output.resolve()
    if not out.is_relative_to(Path('/mnt/ainvr-ssd')):
        p.error('Output must be a new SSD test directory')
    if source.suffix != ('.pt' if args.kind == 'yoloe' else '.ts'):
        p.error('Unexpected source format')
    if args.kind == 'yoloe' and not args.image_f32:
        p.error('YOLOE requires a real hardware-preprocessed 640x640 RGB NCHW input')
    out.mkdir(parents=True, exist_ok=False)
    original_hash = digest(source)
    report = {
        'kind': args.kind, 'source': str(source), 'source_sha256': original_hash,
        'passed': False, 'test_only_cpu_oracle': True,
        'bpu_compiled': False, 'production_inference_verified': False,
        'prompt_text_semantics_verified': False,
    }
    started = time.monotonic()
    try:
        # Prevent Ultralytics dependency/model auto-install or network fallback.
        os.environ['YOLO_AUTOINSTALL'] = 'false'
        config_dir = out / 'ultralytics-config'
        (config_dir / 'Ultralytics').mkdir(parents=True)
        os.environ['YOLO_CONFIG_DIR'] = str(config_dir)
        import numpy as np
        import torch
        import onnx
        import onnxruntime as ort
        import ultralytics
        if torch.__version__.split('+')[0] != '2.9.0' or ultralytics.__version__ != '8.4.142':
            raise RuntimeError('Locked torch 2.9.0 / ultralytics 8.4.142 required')
        torch.set_num_threads(2)
        torch.set_num_interop_threads(1)
        torch.manual_seed(20261012)
        report['versions'] = {k: v for k, v in [
            ('torch', torch.__version__), ('ultralytics', ultralytics.__version__),
            ('onnx', onnx.__version__), ('onnxruntime', ort.__version__)]}

        if args.kind == 'yoloe':
            from ultralytics import YOLOE
            from ultralytics.nn.modules.head import YOLOESegment26
            # Loading user-authorized PT is intentional; only local weights are used.
            loaded = YOLOE(str(source))
            model = loaded.model.cpu().float().eval()
            head = model.model[-1]
            if not isinstance(head, YOLOESegment26) or getattr(head, 'is_fused', False):
                raise RuntimeError('Unfused YOLOESegment26 checkpoint required')
            if hasattr(head, 'lrpc'):
                raise RuntimeError('Prompt-free checkpoint cannot preserve runtime prompts')
            if getattr(head, 'cv2', None) is None:
                raise RuntimeError('Reference NMS path requires the one-to-many head')
            # TecheAI requests nms=True. Select the matching one-to-many head
            # explicitly instead of relying on version-dependent defaults.
            head.end2end = False
            head.nc = 1
            head.no = head.nc + 4 * head.reg_max
            head.export = True
            head.format = 'onnx'
            head.dynamic = False
            model.names = {0: 'runtime_prompt'}
            for parameter in model.parameters():
                parameter.requires_grad_(False)

            class PromptedSegmentation(torch.nn.Module):
                def __init__(self, network):
                    super().__init__()
                    self.network = network

                def forward(self, images, clip_features):
                    # predict applies RepRTA exactly once. set_classes/get_text_pe
                    # would pre-apply/fold it and lose the dynamic-input contract.
                    return self.network.predict(images, tpe=clip_features)

            wrapper = PromptedSegmentation(model).eval()
            image_path = args.image_f32.resolve(strict=True)
            image = np.fromfile(image_path, dtype='<f4')
            if image.size != 3 * 640 * 640 or not np.isfinite(image).all():
                raise RuntimeError('Invalid calibration image tensor')
            if image.min() < 0 or image.max() > 1:
                raise RuntimeError('Expected RGB NCHW float32 normalized to [0,1]')
            image = image.reshape(1, 3, 640, 640)
            features = torch.randn(1, 1, 512)
            features = torch.nn.functional.normalize(features, dim=-1)
            alternate = torch.nn.functional.normalize(torch.randn(1, 1, 512), dim=-1)
            inputs = (torch.from_numpy(image), features)
            cases = [(torch.from_numpy(image), features), (torch.from_numpy(image), alternate)]
            input_names = ['images', 'clip_features']
            output_names = [
                'detections_with_mask_coefficients' if head.end2end else 'raw_predictions_with_mask_coefficients',
                'mask_prototypes',
            ]
            report.update({
                'real_image_sha256': digest(image_path), 'real_image_source': str(image_path),
                'synthetic_prompt_vectors': True, 'prompt_count': 1,
                'embedding_contract': 'raw L2-normalized CLIP [1,1,512]; RepRTA is in graph',
                'mask_contract': 'YOLOESegment26 coefficients and prototypes retained',
                'head_end2end': bool(head.end2end),
                'head_reg_max': head.reg_max,
                'head_selection': 'one-to-many, explicit; reference runtime requests nms=True',
                'checkpoint_yaml_end2end': model.yaml.get('end2end'),
                'detection_layout': ('N xyxy score class mask_coefficients' if head.end2end
                                     else 'C N: box4 class_scores mask_coefficients; NMS required'),
                'box_format': ('xyxy' if head.end2end or getattr(head, 'xyxy', False) else 'xywh'),
            })
        else:
            wrapper = torch.jit.load(str(source), map_location='cpu').eval()
            # Valid synthetic CLIP token sequences verify the encoder interface;
            # these are not claimed to encode user descriptions or label semantics.
            tokens = torch.zeros((1, 77), dtype=torch.int32)
            tokens[0, :3] = torch.tensor([49406, 100, 49407])
            other = tokens.clone()
            other[0, 1] = 200
            inputs = (tokens,)
            cases = [(tokens,), (other,)]
            input_names, output_names = ['tokens'], ['clip_features']
            report['synthetic_token_ids'] = True
            report['token_dtype'] = 'int32, matching official CLIP under PyTorch >=1.8'
            report['normalization'] = 'L2-normalized encoder output; verified before direct YOLOE input'

        graph_path = out / (args.kind + '.onnx')
        with torch.inference_mode():
            expected = []
            for case in cases:
                values = wrapper(*case)
                if isinstance(values, torch.Tensor):
                    values = (values,)
                if not isinstance(values, (tuple, list)) or not all(isinstance(t, torch.Tensor) for t in values):
                    raise RuntimeError('Unexpected output contract')
                expected.append([t.detach().cpu().numpy() for t in values])
            if len(expected[0]) != len(output_names):
                raise RuntimeError('Output arity mismatch')
            report['torch_output_shapes'] = [list(t.shape) for t in expected[0]]
            if args.kind == 'yoloe':
                anchors = sum((640 // int(stride)) ** 2 for stride in model.stride)
                prediction_shape = ((1, 300, 6 + head.nm) if head.end2end
                                    else (1, 4 + head.nc + head.nm, anchors))
                if expected[0][0].shape != prediction_shape or expected[0][1].shape != (1, head.nm, 160, 160):
                    raise RuntimeError('Unexpected segmentation tensor shapes')
            elif expected[0][0].shape != (1, 512):
                raise RuntimeError('Unexpected text encoder feature shape')
            if args.kind == 'text-encoder':
                for values in expected:
                    np.testing.assert_allclose(np.linalg.norm(values[0], axis=-1), 1,
                                               rtol=1e-5, atol=1e-5)
                # The stock legacy exporter loses rank after aten::unflatten in
                # this frozen TorchScript attention graph. Preserve only its
                # mathematically determined rank; values/Reshape stay stock.
                from torch.onnx import symbolic_helper, symbolic_opset13
                ranks = []

                def unflatten_with_rank(g, value, dim, sizes):
                    rank = symbolic_helper._get_tensor_rank(value)
                    if symbolic_helper._is_packed_list(sizes):
                        count = len(symbolic_helper._unpack_list(sizes))
                    else:
                        shape = symbolic_helper._get_tensor_sizes(sizes)
                        count = shape[0] if shape and len(shape) == 1 else None
                    if rank is None or count is None or count < 1:
                        raise RuntimeError('Cannot prove unflatten result rank')
                    result = symbolic_opset13.unflatten(g, value, dim, sizes)
                    result_rank = rank - 1 + count
                    result.setType(value.type().with_sizes([None] * result_rank))
                    ranks.append({'input_rank': rank, 'expanded_dimensions': count,
                                  'output_rank': result_rank})
                    return result

                torch.onnx.register_custom_op_symbolic('aten::unflatten', unflatten_with_rank, 17)
            try:
                torch.onnx.export(wrapper, inputs, str(graph_path), opset_version=17,
                                  input_names=input_names, output_names=output_names,
                                  dynamo=False, do_constant_folding=True)
            finally:
                if args.kind == 'text-encoder':
                    torch.onnx.unregister_custom_op_symbolic('aten::unflatten', 17)
                    report['unflatten_rank_annotations'] = ranks

        graph = onnx.load(str(graph_path))
        onnx.checker.check_model(graph, full_check=True)
        if [i.name for i in graph.graph.input] != input_names:
            raise RuntimeError('Export dropped or changed required runtime input')
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_BASIC
        session = ort.InferenceSession(str(graph_path), sess_options=options,
                                       providers=['CPUExecutionProvider'])
        parity = []
        actual_cases = []
        for index, case in enumerate(cases):
            actual = session.run(None, {name: t.numpy() for name, t in zip(input_names, case)})
            actual_cases.append(actual)
            for name, ref, value in zip(output_names, expected[index], actual):
                if ref.shape != value.shape or not np.isfinite(value).all():
                    raise RuntimeError('Invalid ONNX output shape/numbers')
                delta = np.abs(ref - value)
                parity.append({'case': index, 'output': name, 'shape': list(value.shape),
                               'max_abs_error': float(delta.max()),
                               'mean_abs_error': float(delta.mean())})
                np.testing.assert_allclose(value, ref, rtol=0.002, atol=0.002)
        # Prove that the prompt/token input affects exported results.
        change = float(np.abs(actual_cases[0][0] - actual_cases[1][0]).max())
        if change <= 1e-6:
            raise RuntimeError('Runtime prompt/token input has no observed effect')
        report.update({'passed': True, 'onnx_sha256': digest(graph_path),
                       'onnx_path': str(graph_path), 'onnx_bytes': graph_path.stat().st_size,
                       'parity': parity, 'changed_input_max_output_difference': change,
                       'inputs': [i.name for i in graph.graph.input],
                       'outputs': [o.name for o in graph.graph.output]})
    except Exception as exc:
        report['error'] = type(exc).__name__ + ': ' + str(exc)
        raise
    finally:
        report['source_unchanged'] = digest(source) == original_hash
        if not report['source_unchanged']:
            report['passed'] = False
        report['elapsed_seconds'] = time.monotonic() - started
        (out / 'summary.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report), flush=True)


if __name__ == '__main__':
    main()
