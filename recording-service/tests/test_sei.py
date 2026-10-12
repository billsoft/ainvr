import json
from recorder.sei_worker import UUID, has_ainvr_sei, packet_has_sei
from recorder.index import SegmentIndex


def _sei_nal(det):
    payload = UUID + json.dumps({'v': 1, 'det': det}).encode()
    return b'\x06\x05' + bytes([len(payload)]) + payload + b'\x80'


def test_verified_sei_only():
    nal = _sei_nal([{'c': 0}])
    assert has_ainvr_sei(nal)
    # 空 det 帧（AI 在跑但没检出目标）不算"有识别"，时间轴不标
    assert not has_ainvr_sei(_sei_nal([]))
    assert packet_has_sei(len(nal).to_bytes(4, 'big') + nal, 4, False)
    assert not has_ainvr_sei(nal.replace(UUID, b'x' * len(UUID)))
    assert not has_ainvr_sei(nal[:-10])
    assert not has_ainvr_sei(b'\x65' + nal)
    assert not packet_has_sei(b'\x00\x00\xff\xff' + nal, 4, False)


def test_index_unknown_and_known_empty_are_distinct(tmp_path):
    index = SegmentIndex(str(tmp_path / 'segments.db'))
    row = dict(id='x', channelId='c', channelName='c', streamName='c', startTs=0,
               endTs=60000, durationMs=60000, sizeBytes=100, codec='h264',
               storage='local', relPath='test.mp4', complete=True, seiPresent=True)
    index.upsert_segment(row)
    stored = index.get('x')
    assert stored['seiRanges'] is None
    assert not stored['seiPresent']  # AI channel flag alone is not evidence.
    index.set_sei_ranges(stored, [[10, 40]])
    assert index.get('x')['seiPresent']
    assert index.get('x')['seiRanges'] == [[10, 40]]
    index.set_sei_ranges({**stored, 'sizeBytes': 101}, [])
    assert index.get('x')['seiPresent']  # Stale worker cannot overwrite a new file.
    index.set_sei_ranges(stored, [])
    assert index.get('x')['seiRanges'] == []
    assert index.pending_sei() == []
    index.close()
