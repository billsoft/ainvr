import threading
from fastapi.responses import JSONResponse
from recorder.index import SegmentIndex


def populate(index):
    row = dict(id='dense', channelId='ch1', channelName='camera', streamName='s',
               startTs=1000, endTs=61000, durationMs=60000, sizeBytes=100,
               codec='h264', storage='local', relPath='dense.mp4', complete=True)
    index.upsert_segment(row)
    stored = index.get('dense')
    ranges = [[i, i + 1] for i in range(0, 60000, 33)]
    index.set_sei_ranges(stored, ranges)
    return ranges


def test_dense_list_serializes_on_index_worker_and_preserves_ranges(client, monkeypatch):
    import recorder.app as app_module
    ranges = populate(client.app.state.index)
    threads = []
    class CheckedResponse(JSONResponse):
        def render(self, content):
            threads.append(threading.current_thread().name)
            return super().render(content)
    monkeypatch.setattr(app_module, 'JSONResponse', CheckedResponse)
    response = client.get('/v1/recordings/segments', params={'channel': 'ch1', 'from': 1, 'to': 62000})
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'
    assert response.json()[0]['seiRanges'] == ranges
    assert response.json()[0]['seiPresent'] is True
    assert threads and all(name.startswith('recorder-index') for name in threads)


def test_scanner_inventory_does_not_decode_sei(tmp_path, monkeypatch):
    import recorder.index as module
    index = SegmentIndex(str(tmp_path / 'segments.db'))
    try:
        populate(index)
        def forbidden(*args):
            raise AssertionError('scanner must not parse SEI')
        monkeypatch.setattr(module.json, 'loads', forbidden)
        row = index.all_segments(include_sei=False)[0]
        assert row['id'] == 'dense' and row['relPath'] == 'dense.mp4'
        assert row['seiPresent'] is True and row['seiRanges'] is None
    finally:
        index.close()
