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
