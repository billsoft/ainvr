"""Experimental OE 3.7.0 requantization using preserved calibration thresholds.

This does not collect new statistics and is not a quality certificate. The
source calibration must correspond to the same graph, preprocessing and
dataset. Use an isolated output directory and independent real-board tests.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import time


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--calibrated', type=Path, required=True)
    p.add_argument('--expected-sha256', required=True)
    p.add_argument('--original-float', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    p.add_argument('--prefix', choices=['yolo26x_face_requant', 'yolo26x_requant'], required=True)
    p.add_argument('--ptq-only', action='store_true',
                   help='Write PTQ ONNX for an offline correctness check before code generation')
    p.add_argument('--weight-type', choices=['int8', 'int16'], default='int8')
    p.add_argument('--resize-implementation', choices=['native_int8', 'bpu_repeat_int16'],
                   default='native_int8')
    p.add_argument('--softmax-sub-range', type=float,
                   help='Override INT8-derived Softmax difference clipping for INT16; independent validation required')
    a = p.parse_args()
    sha = lambda f: hashlib.sha256(f.read_bytes()).hexdigest()
    assert sha(a.calibrated) == a.expected_sha256
    if a.softmax_sub_range is not None:
        assert 8 <= a.softmax_sub_range <= 32
    a.output.mkdir(exist_ok=False)
    report = {'calibrated_sha256': a.expected_sha256,
              'original_float_sha256': sha(a.original_float),
              'started_unix': time.time(), 'calibration_repeated': False,
              'accuracy_verified': False, 'production_approved': False,
              'state': 'preparing', 'changes': []}

    def save():
        (a.output / 'status.json').write_text(json.dumps(report, indent=2))

    save()
    import onnx
    from hmct.ir import OnnxModel, CalibrationNode
    from hmct.builder.model_builder import ModelBuilder
    from hbdk4.compiler.onnx import export
    from hbdk4.compiler import convert, save as save_bc, compile
    try:
        model = OnnxModel(str(a.calibrated))
        original = OnnxModel(str(a.original_float))
        assert {k: tuple(v) for k, v in model.graph.input_shapes.items()} == {
            'images': (1, 3, 640, 640)}, model.graph.input_shapes
        if a.resize_implementation == 'bpu_repeat_int16':
            import numpy as np
            geometry = {}
            for node in model.graph.nodes:
                if node.op_type != 'Resize':
                    continue
                assert node.attributes['mode'] == 'nearest'
                assert node.attributes['coordinate_transformation_mode'] == 'asymmetric'
                assert node.attributes['nearest_mode'] == 'floor'
                shape = tuple(node.inputs[0].shape)
                assert node.outputs[0].shape == [shape[0], shape[1], shape[2]*2, shape[3]*2]
                geometry[node.name] = shape
            assert len(geometry) == 2

            def repeat_graph(proto):
                nodes = []
                for node in proto.graph.node:
                    if node.op_type != 'Resize':
                        nodes.append(node); continue
                    n, c, h, w = geometry[node.name]
                    prefix = node.name + '_ainvr_repeat'
                    shapes = [[n*c*h, w, 1], [n, c, h, 2*w],
                              [n*c, h, 1, 2*w], [n, c, 2*h, 2*w]]
                    for i, shape in enumerate(shapes):
                        proto.graph.initializer.append(onnx.numpy_helper.from_array(
                            np.asarray(shape, dtype=np.int64), prefix+'_shape'+str(i)))
                    value = node.input[0]
                    for suffix, shape_index, axis in [('cols', 0, 2), ('rows', 2, 2)]:
                        viewed = prefix+'_'+suffix+'_view'; doubled = prefix+'_'+suffix+'_double'
                        nodes.append(onnx.helper.make_node('Reshape',
                            [value, prefix+'_shape'+str(shape_index)], [viewed], name=viewed))
                        nodes.append(onnx.helper.make_node('Concat', [viewed, viewed],
                            [doubled], axis=axis, name=doubled))
                        value = prefix+'_'+suffix+'_result' if suffix=='cols' else node.output[0]
                        nodes.append(onnx.helper.make_node('Reshape',
                            [doubled, prefix+'_shape'+str(shape_index+1)], [value],
                            name=prefix+'_'+suffix+'_reshape'))
                del proto.graph.node[:]
                proto.graph.node.extend(nodes)
                rewritten = OnnxModel(proto)
                rewritten.infer_shapes().check_validity()
                return rewritten

            # Exact nearest-2x duplication, without loss through INT8 resize
            # boundaries. Original weights and calibration statistics persist.
            model = repeat_graph(model.proto)
            original = repeat_graph(original.proto)
            report['resize_rewrite'] = {'kind': 'nearest_2x_reshape_concat',
                                       'geometry': geometry, 'fp32_parity_verified': False}
            onnx.save_model(original.proto, a.output / 'rewritten_original_float.onnx')
        float_boundaries = [
            '/model.23/Concat_3_output_0_HzCalibration',
            '/model.23/Transpose_output_0_HzCalibration',
            '/model.23/Cast_output_0_HzCalibration',
            'output0_HzCalibration',
        ]
        present = {n.name for n in model.graph.nodes}
        assert all(name in present for name in float_boundaries)
        producers = {v.name: n for n in model.graph.nodes for v in n.outputs}
        resize_boundaries = set()
        for node in model.graph.nodes:
            if node.op_type != 'Resize':
                continue
            before = producers[node.inputs[0].name]
            assert isinstance(before, CalibrationNode)
            resize_boundaries.add(before.name)
            outputs = {v.name for v in node.outputs}
            resize_boundaries.update(n.name for n in model.graph.nodes
                if isinstance(n, CalibrationNode) and n.inputs[0].name in outputs)
        assert len(resize_boundaries) == (4 if a.resize_implementation == 'native_int8' else 0), resize_boundaries
        report['int8_resize_boundaries'] = sorted(resize_boundaries)
        weight_before = {}
        for node in model.graph.nodes:
            if not isinstance(node, CalibrationNode):
                continue
            if node.tensor_type == 'weight':
                weight_before[node.name] = (node.qtype, node.thresholds)
                if a.weight_type == 'int16':
                    node.qtype = 'int16'
                    node.qtype_priority = 100
                    _ = node.scales
                continue
            if node.tensor_type != 'feature' or node.qtype not in ('int8', 'int16'):
                continue
            before = {'qtype': node.qtype, 'switch': node.switch,
                      'thresholds': node.thresholds}
            if node.name in float_boundaries:
                node.qtype = 'float32'
                node.switch = 'OFF'
            else:
                # Nash's model-internal nearest Resize requires INT8. Keeping
                # its boundaries INT8 avoids a forbidden neural CPU fallback.
                node.qtype = 'int8' if node.name in resize_boundaries else 'int16'
                node.qtype_priority = 100
                # Refresh the derived scale for the new integer range while
                # retaining the previously collected floating-point threshold.
                _ = node.scales
            report['changes'].append({'name': node.name, 'before': before,
                                      'after': {'qtype': node.qtype, 'switch': node.switch}})
        assert weight_before and all(
            n.thresholds == weight_before[n.name][1]
            for n in model.graph.nodes
            if isinstance(n, CalibrationNode) and n.tensor_type == 'weight')
        report['weight_statistics_unchanged'] = True
        report['weight_precision'] = a.weight_type
        report['feature_precision_counts'] = dict(Counter(
            n.qtype for n in model.graph.nodes
            if isinstance(n, CalibrationNode) and n.tensor_type == 'feature'))
        if a.softmax_sub_range is not None:
            corrections = []
            for node in model.graph.nodes:
                if isinstance(node, CalibrationNode) and 'Softmax_output_0_sub_HzCalibration' in node.name:
                    assert node.tensor_type == 'feature' and node.qtype == 'int16'
                    corrections.append({'name': node.name, 'previous_thresholds': node.thresholds,
                                        'new_threshold': a.softmax_sub_range})
                    node.thresholds = [a.softmax_sub_range]
                    _ = node.scales
            assert len(corrections) == 3
            report['softmax_range_corrections'] = corrections
        model.infer_shapes().check_validity()
        onnx.save_model(model.proto, a.output / 'modified_calibrated.onnx')
        report['state'] = 'requantizing'; save()
        # The builder initializes HMCT's global march, quantization mode and
        # optimization context. Calling the backend function directly can
        # silently select incompatible integer LUTs despite a Nash argument.
        builder = ModelBuilder(onnx_model=original, march='nash-m',
                               save_model=False, verbose=False)
        builder.original_model = original
        quantized = builder.quantize(model)
        quantized.infer_shapes().check_validity()
        onnx.save_model(quantized.proto, a.output / 'ptq.onnx')
        if a.ptq_only:
            report['state'] = 'quantized_needs_offline_validation'
            return
        report['state'] = 'converting'; save()
        module = export(proto=quantized.proto, name=a.prefix)
        save_bc(module, str(a.output / 'exported.bc'))
        module = convert(module, march='nash-m', advice=True,
                         advice_path=str(a.output) + '/')
        advice_path = a.output / (a.prefix + '_advice.json')
        assert advice_path.is_file()
        ops = json.loads(advice_path.read_text())
        def cpu_result_logic(op):
            if not op['op_name'].startswith('/model.23/'):
                return False
            if not op['input_types'] or not all(t.startswith('si') for t in op['input_types']):
                return False
            if op['op_type'] in {'hbir.cast_type', 'hbir.gather_elements'}:
                return True
            return op['op_type'] == 'hbtl.call' and op['op_name'] in {
                '/model.23/Mod', '/model.23/Div_1'}
        assert set(op['backend'] for op in ops) <= {'bpu', 'external_cpu'}
        rejected = [op for op in ops if op['backend'] == 'external_cpu' and not cpu_result_logic(op)]
        report['cpu_neural_fallback_rejected_ops'] = rejected
        save()
        assert not rejected, 'Neural CPU fallback; do not compile or deploy this candidate'
        save_bc(module, str(a.output / 'quantized.bc'))
        report['quantized_bc_sha256'] = sha(a.output / 'quantized.bc')
        report['state'] = 'compiling'; save()
        compile(module, str(a.output / 'model.hbm'), march='nash-m', opt=0,
                jobs=1, debug=False, progress_bar=True)
        report.update(state='compiled_needs_validation', hbm_sha256=sha(a.output / 'model.hbm'))
    except Exception as e:
        report.update(state='failed', error=str(e), error_type=type(e).__name__)
        raise
    finally:
        assert sha(a.calibrated) == a.expected_sha256
        report['finished_unix'] = time.time()
        save()


if __name__ == '__main__':
    main()
