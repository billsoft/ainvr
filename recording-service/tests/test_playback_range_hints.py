from recorder.index import SegmentIndex


def test_range_checks_real_segments_and_retains_latest_outside_window(tmp_path):
    index = SegmentIndex(str(tmp_path / "segments.sqlite"))
    try:
        for start, end, complete in [(10, 20, 1), (30, 40, 0), (100, 110, 1)]:
            index.conn.execute(
                "INSERT INTO segments(id,channel_id,channel_name,stream_name,start_ts,end_ts,"
                "duration_ms,size_bytes,codec,storage,rel_path,created_at,complete)"
                " VALUES(?, 'camera','Camera','stream',?,?,10,100,'h264','local','r',0,?)",
                (str(start), start, end, complete))
        assert index.playback_hints(["camera", "empty"], 20, 100) == {
            "camera": (False, 100), "empty": (False, None)}
        assert index.playback_hints(["camera"], 19, 21)["camera"] == (True, 100)
    finally:
        index.close()


def test_range_hints_follow_active_storage(tmp_path):
    index = SegmentIndex(str(tmp_path / "segments.sqlite"))
    try:
        for identity, storage, start in [("old", "a", 100), ("new", "b", 10)]:
            index.conn.execute(
                "INSERT INTO segments(id,channel_id,channel_name,stream_name,start_ts,end_ts,"
                "duration_ms,size_bytes,codec,storage,storage_id,rel_path,created_at,complete)"
                " VALUES(?,'camera','Camera','stream',?,?,10,100,'h264','local',?,'r',0,1)",
                (identity, start, start + 10, storage))
        index.activate_storage("b")
        assert index.playback_hints(["camera"], 100, 120) == {"camera": (False, 10)}
        assert index.playback_hints(["camera"], 10, 20) == {"camera": (True, 10)}
    finally:
        index.close()


def test_channel_range_validation_and_legacy_response(client, monkeypatch):
    monkeypatch.setattr(client.app.state.channels, "to_api", lambda: [{"id": "camera"}])
    plain = client.get("/v1/recorder/channels")
    assert plain.status_code == 200
    assert "rangeHasRecording" not in plain.json()[0]
    for params in ({"from": 1}, {"to": 2}, {"from": -1, "to": 2},
                   {"from": 2, "to": 2}, {"from": 2, "to": 1},
                   {"from": 1, "to": 2**53}):
        assert client.get("/v1/recorder/channels", params=params).status_code == 400
    result = client.get("/v1/recorder/channels", params={"from": 1, "to": 2})
    assert result.status_code == 200
    assert result.json()[0]["rangeHasRecording"] is False
    assert result.json()[0]["latestSegmentTs"] is None
