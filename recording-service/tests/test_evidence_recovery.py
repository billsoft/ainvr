import pytest
from recorder.evidence_recovery import matches, validate_request

def request():
    return dict(channel_id='ai', stream_session_id='ai:session:1', source_pts_ns='123000000',
                track_id='ai:session:1:4', captured_at='2026-10-26T08:00:00Z', width=1920, height=1080)

def test_exact_identity_required():
    r=request(); assert validate_request(r)>0
    payload={'ch':'ai','pts':123000000,'det':[{'t':r['track_id']}]}
    assert matches(payload,r)
    for key,value in [('ch','input'),('pts',123000001),('det',[{'t':'other'}]),('det',[{'t':r['track_id'],'pr':1}]),('det',[{'t':r['track_id'],'lc':1}])]:
        assert not matches({**payload,key:value},r)

@pytest.mark.parametrize('change',[{'track_id':'another:4'},{'captured_at':'2026-10-26T08:00:00'},{'source_pts_ns':'-1'},{'width':True},{'height':0}])
def test_invalid_requests_fail_closed(change):
    with pytest.raises(ValueError):validate_request({**request(),**change})

def test_output_selection_separates_processors_and_rejects_ambiguous_mapping():
    from recorder.channels import ChannelManager
    directory = ChannelManager.__new__(ChannelManager)
    directory._processor_outputs = {'ai-a': ('live', 'out-a'), 'ai-b': ('live', 'out-b')}
    directory.channels = [{'id': 'raw', 'app': 'live', 'streamName': 'input'},
                          {'id': 'output-a', 'app': 'live', 'streamName': 'out-a'},
                          {'id': 'output-b', 'app': 'live', 'streamName': 'out-b'}]
    assert directory.recording_channel_for_processor('ai-a') == 'output-a'
    assert directory.recording_channel_for_processor('ai-b') == 'output-b'
    assert directory.recording_channel_for_processor('unknown') is None
    directory.channels.append({'id': 'duplicate', 'app': 'live', 'streamName': 'out-a'})
    assert directory.recording_channel_for_processor('ai-a') is None

def test_exited_worker_with_live_decoder_group_blocks_new_recovery(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from fastapi import HTTPException
    from recorder.evidence_recovery import EvidenceRecovery
    recovery = EvidenceRecovery()
    recovery.proc = SimpleNamespace(returncode=0)
    recovery.group = 12345
    monkeypatch.setattr('os.killpg', lambda pid, sig: None)
    with pytest.raises(HTTPException) as error:
        asyncio.run(recovery.recover(request(), []))
    assert error.value.status_code == 503
    assert error.value.detail == 'recovery_busy'


def test_dead_process_group_releases_recovery_slot(monkeypatch):
    from recorder.evidence_recovery import EvidenceRecovery
    recovery = EvidenceRecovery()
    recovery.group = 12345
    def missing(pid, sig):
        raise ProcessLookupError()
    monkeypatch.setattr('os.killpg', missing)
    assert recovery.group_alive() is False
    assert recovery.group is None


def test_successful_worker_still_cleans_decoder_process_group(monkeypatch):
    import asyncio
    import signal
    from recorder.evidence_recovery import EvidenceRecovery
    class Worker:
        pid = 12345
        returncode = 0
        async def communicate(self, data):
            return b'{"ok":true}', b''
    async def spawn(*args, **kwargs):
        return Worker()
    calls = []
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    monkeypatch.setattr('os.killpg', lambda pid, sig: calls.append((pid, sig)))
    recovery = EvidenceRecovery()
    assert asyncio.run(recovery.recover(request(), [])) == {'ok': True}
    assert (12345, signal.SIGKILL) in calls


def test_route_does_not_discard_exact_sei_candidates_by_observation_size(client, store, monkeypatch):
    """Route selects by identity/time; the worker must verify each frame's geometry."""
    import os
    from datetime import datetime
    from recorder.evidence_recovery import EvidenceRecovery
    r = {**request(), 'width': 7680, 'height': 4320, 'source_frame_index': '42'}
    at = int(datetime.fromisoformat(r['captured_at'].replace('Z', '+00:00')).timestamp() * 1000)
    root = store.get().recording.storage.localPath
    rel = 'recover-exact-sei.mp4'
    with open(os.path.join(root, rel), 'wb') as out:
        out.write(b'fixture')
    channels = client.app.state.channels
    channels.channels = [{'id': 'ai-output', 'app': 'live', 'streamName': 'ai', 'kind': 'ai', 'kindConfirmed': True}]
    channels._processor_outputs = {'ai': ('live', 'ai')}
    client.app.state.index.upsert_segment({'id': 'recover-fixture', 'channelId': 'ai-output', 'channelName': 'AI',
        'streamName': 'ai', 'startTs': at - 1000, 'endTs': at + 1000, 'durationMs': 2000,
        'sizeBytes': 7, 'codec': 'h264', 'width': 1920, 'height': 1080, 'fps': 30,
        'hasAudio': False, 'storage': 'local', 'relPath': rel, 'complete': True})
    async def recover(_self, body, segments):
        assert body == r
        return {'candidate_ids': [seg['id'] for seg in segments]}
    monkeypatch.setattr(EvidenceRecovery, 'recover', recover)
    response = client.post('/v1/recordings/recover-evidence', json=r)
    assert response.status_code == 200
    assert response.json()['candidate_ids'] == ['recover-fixture']


def test_route_never_scans_other_outputs_when_source_binding_is_unknown(client, monkeypatch):
    from recorder.evidence_recovery import EvidenceRecovery
    async def unexpected(*_args):
        pytest.fail('unknown binding must not scan all other camera recordings')
    monkeypatch.setattr(EvidenceRecovery, 'recover', unexpected)
    response = client.post('/v1/recordings/recover-evidence', json=request())
    assert response.status_code == 404
    assert response.json()['detail'] == 'recording_channel_unavailable'


def test_recovery_geometry_accepts_only_an_explicit_same_frame_full_extent_proof():
    from recorder.evidence_recovery import recovery_geometry
    r = {**request(), 'width': 7680, 'height': 4320, 'source_frame_index': '42'}
    proof = {'schema': 'recording-frame-geometry-v1', 'method': 'full_frame_axis_scale',
             'observation_size': [7680, 4320], 'encoded_size': [1920, 1080], 'source_frame_index': '42'}
    payload = {'model_extra': {'recording_evidence_geometry': proof}}
    accepted = recovery_geometry(payload, r, 1920, 1080)
    assert accepted['encoded_size'] == [1920, 1080]
    assert accepted['source_frame_index'] == '42'
    for patch in ({'method': 'crop'}, {'observation_size': [1920, 1080]},
                  {'encoded_size': [1280, 720]}, {'source_frame_index': '41'}, {'schema': 'unknown'}):
        with pytest.raises(ValueError, match='recording_geometry_unverified'):
            recovery_geometry({'model_extra': {'recording_evidence_geometry': {**proof, **patch}}}, r, 1920, 1080)
    for no_proof in ({}, {'model_extra': {}}, {'model_extra': 'bad'}):
        with pytest.raises(ValueError, match='recording_geometry_unverified'):
            recovery_geometry(no_proof, r, 1920, 1080)
    with pytest.raises(ValueError):
        recovery_geometry(payload, {k: v for k, v in r.items() if k != 'source_frame_index'}, 1920, 1080)
    with pytest.raises(ValueError):
        recovery_geometry(payload, r, 1920, 1000)   # no stretching
    assert recovery_geometry({}, request(), 1920, 1080)['method'] == 'same_dimensions'


@pytest.mark.parametrize('index', ['01', '-1', '1.2', 42, None, ''])
def test_invalid_optional_frame_indexes_are_rejected(index):
    with pytest.raises(ValueError):
        validate_request({**request(), 'source_frame_index': index})


def test_safe_worker_failure_reason_is_preserved_without_exception_text(monkeypatch):
    import asyncio
    from fastapi import HTTPException
    from recorder.evidence_recovery import EvidenceRecovery
    class Worker:
        pid = 23456
        returncode = 1
        async def communicate(self, data):
            return b'{"error":"recording_geometry_unverified"}', b''
    async def spawn(*args, **kwargs):
        return Worker()
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    monkeypatch.setattr('os.killpg', lambda *_: None)
    with pytest.raises(HTTPException) as error:
        asyncio.run(EvidenceRecovery().recover(request(), []))
    assert error.value.status_code == 409
    assert error.value.detail == 'recording_geometry_unverified'


def test_jpeg_geometry_is_metadata_only_and_missing_headers_fail_closed():
    from recorder.evidence_recovery import jpeg_dimensions
    jpeg = bytes.fromhex('ffd8ffc000110802d0050003012200021101031101ffd9')
    assert jpeg_dimensions(jpeg) == (1280, 720)
    with pytest.raises(ValueError, match='invalid_image'):
        jpeg_dimensions(b'\xff\xd8\xff\xd9')


def test_mp4_parser_retains_visual_sample_extent_without_decoding():
    import struct
    from test_mp4_samples import moov
    from recorder.mp4_samples import _parse_moov
    data = bytearray(moov(codec=b'avc1'))
    start = data.index(b'avc1') + 4
    struct.pack_into('>HH', data, start + 24, 1920, 1080)
    info = _parse_moov(bytes(data))[2]
    assert (info.width, info.height) == (1920, 1080)
