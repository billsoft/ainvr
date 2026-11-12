import json
from recorder.timeline_summary import TimelineSummaryCache
from test_list_responsiveness import populate


def test_summary_is_opt_in_and_raw_ranges_stay_exact(client):
    raw = populate(client.app.state.index)
    params = {'channel':'ch1','from':1,'to':62000}
    summary = client.get('/v1/recordings/segments', params={**params,'sei_bucket_ms':1000}).json()[0]
    assert summary['seiRanges'] == [[0,60000]]
    assert summary['seiResolutionMs'] == 1000
    exact = client.get('/v1/recordings/segments', params=params).json()[0]
    assert exact['seiRanges'] == raw
    assert 'seiResolutionMs' not in exact


def test_cache_preserves_gaps_and_refreshes_changed_data():
    cache = TimelineSummaryCache()
    raw = json.dumps([[100,110],[150,160],[500,510]])
    assert cache.get(raw,100,550) == [[100,200],[500,550]]
    assert cache.get(json.dumps([[100,110]]),100,550) == [[100,200]]
    assert cache.get(raw,10,550) == [[100,110],[150,160],[500,510]]


def test_cache_reuses_summary_without_parsing_and_is_bounded(monkeypatch):
    cache=TimelineSummaryCache(max_bytes=1000,max_entries=2)
    raw='[[0,10]]'
    cache.get(raw,100,1000)
    with monkeypatch.context() as m:
        m.setattr(json,'loads',lambda x: (_ for _ in ()).throw(AssertionError('cache miss')))
        assert cache.get(raw,100,1000)==[[0,100]]
    for i in range(20): cache.get(json.dumps([[i,i+1]]),100,1000)
    assert cache.bytes<=1000 and len(cache.rows)<=2
