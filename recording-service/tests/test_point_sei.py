"""Cross-language original C++ producer bytes;no synthetic model inference."""
import copy
import io
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from recorder import sei_worker

FIXTURES = json.loads((Path(__file__).parents[2] / 'test/results/locateanything-point-sei-fixtures-v1.json').read_text())['fixtures']


@pytest.mark.parametrize('fixture', FIXTURES, ids=lambda f: f["codec"] + '-' + f["kind"])
def test_actual_cpp_bytes_preserve_metadata_and_index_points(fixture):
    hevc = fixture['codec'] == 'h265'
    nal = bytes.fromhex(fixture['nal_hex'])
    expected = fixture['payload']
    assert sei_worker.read_ainvr_sei(nal, hevc) == expected
    assert sei_worker.has_ainvr_sei(nal, hevc) == (fixture['kind'] != 'clear')
    packet = len(nal).to_bytes(4, 'big') + nal
    assert sei_worker.packet_has_sei(packet, 4, hevc) == (fixture['kind'] != 'clear')
    assert sei_worker.packet_prefix_metadata(io.BytesIO(packet), 0, len(packet), 4, hevc) == expected
    assert sei_worker.packet_prefix_has_sei(io.BytesIO(packet), 0, len(packet), 4, hevc) == (fixture['kind'] != 'clear')
    if fixture['kind'] == 'point':
        assert expected['det'] == []
        assert expected['model_extra']['grounding']['points'][0]['label_id'] == 'stable-point'


def test_point_only_recorded_window_and_ranges_use_mp4_pts(tmp_path, monkeypatch):
    rows = {f['kind']: f for f in FIXTURES if f['codec'] == 'h264'}
    packets = []
    for kind in ['point', 'clear', 'budget']:
        nal = bytes.fromhex(rows[kind]['nal_hex'])
        packets.append(len(nal).to_bytes(4, 'big') + nal)
    path = tmp_path / 'point-metadata.mp4'
    path.write_bytes(b''.join(packets))
    positions = [0, len(packets[0]), len(packets[0]) + len(packets[1])]
    samples = [SimpleNamespace(pts=t, duration=.033, pos=pos, size=len(packet))
               for t, pos, packet in zip([.1, .2, .3], positions, packets)]
    monkeypatch.setattr(sei_worker.mp4_samples, 'read_video_samples',
                        lambda _: (SimpleNamespace(codec='h264', length_size=4), samples))
    frames = sei_worker.scan_frames(str(path), 0, 1000)
    assert [f['timeMs'] for f in frames] == [100, 200, 300]
    assert frames[0]['payload']['model_extra']['grounding']['points'][0]['x'] == .5
    assert frames[1]['payload']['model_extra']['grounding']['points'] == []
    assert sei_worker.scan(str(path), 1000) == [[100, 133], [300, 333]]


def test_invalid_or_unfinished_point_metadata_is_not_a_target():
    valid = next(f['payload'] for f in FIXTURES if f['codec'] == 'h264' and f['kind'] == 'point')
    assert sei_worker._has_targets(valid)
    for field, value in [('x', -1), ('y', 2), ('x', True), ('y', float('nan')),
                         ('confidence', float('inf'))]:
        bad = copy.deepcopy(valid)
        bad['model_extra']['grounding']['points'][0][field] = value
        assert not sei_worker._has_targets(bad)
    for field, value in [('complete', False), ('coordinate_space', 'pixels')]:
        bad = copy.deepcopy(valid)
        bad['model_extra']['grounding'][field] = value
        assert not sei_worker._has_targets(bad)


def test_actual_fragmented_mp4_parser_indexes_cpp_point_nals_without_mocked_samples(tmp_path):
    from test_sei_scan_real_mp4 import build_hevc_fragmented, au, hevc_nal

    rows = {f['kind']: f for f in FIXTURES if f['codec'] == 'h265'}
    picture = hevc_nal(19, b'\xaa' * 1000)
    frames = [au(bytes.fromhex(rows[kind]['nal_hex']), picture) for kind in ['point', 'clear', 'budget']]
    frames.append(au(picture))
    path = tmp_path / 'points-fragmented.mp4'
    build_hevc_fragmented(path, frames)
    assert sei_worker.scan(str(path), 1000) == [[0, 34], [67, 101]]
    readback = sei_worker.scan_frames(str(path), 0, 1000)
    assert len(readback) == 3
    assert readback[0]['payload'] == rows['point']['payload']
    assert readback[1]['payload'] == rows['clear']['payload']
    assert readback[2]['payload'] == rows['budget']['payload']
