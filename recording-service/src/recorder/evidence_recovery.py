"""Bounded exact-frame recovery; never infer frame identity from wall time alone."""
import asyncio
import base64
import json
import os
import signal
import sys
import tempfile
from datetime import datetime
from fastapi import HTTPException

def validate_request(body):
    if not isinstance(body, dict):
        raise ValueError('invalid_request')
    for key in ('channel_id', 'stream_session_id', 'source_pts_ns', 'track_id', 'captured_at'):
        if not isinstance(body.get(key), str) or not 0 < len(body[key]) <= 300:
            raise ValueError('invalid_request')
    if not body['source_pts_ns'].isdigit() or len(body['source_pts_ns']) > 20:
        raise ValueError('invalid_request')
    if not body['track_id'].startswith(body['stream_session_id'] + ':'):
        raise ValueError('session_mismatch')
    for key in ('width', 'height'):
        if type(body.get(key)) is not int or not 32 <= body[key] <= 8192:
            raise ValueError('invalid_dimensions')
    at = datetime.fromisoformat(body['captured_at'].replace('Z', '+00:00'))
    if at.tzinfo is None:
        raise ValueError('invalid_time')
    return int(at.timestamp() * 1000)

def matches(payload, request):
    return (isinstance(payload, dict) and payload.get('ch') == request['channel_id']
            and str(payload.get('pts')) == request['source_pts_ns']
            and any(d.get('t') == request['track_id'] and not d.get('pr') and not d.get('lc')
                    for d in payload.get('det', []) if isinstance(d, dict)))

class EvidenceRecovery:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.proc = None
        self.group = None

    def group_alive(self):
        if self.group is None:
            return False
        try:
            os.killpg(self.group, 0)
            return True
        except ProcessLookupError:
            self.group = None
            return False

    async def recover(self, request, segments):
        if self.lock.locked() or self.group_alive() or (self.proc and self.proc.returncode is None):
            raise HTTPException(503, 'recovery_busy')
        async with self.lock:
            temp = tempfile.TemporaryDirectory(prefix='ainvr-recovery-', dir='/dev/shm')
            try:
                self.proc = await asyncio.create_subprocess_exec(
                    sys.executable, '-m', 'recorder.evidence_recovery',
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL, start_new_session=True,
                    limit=3*1024*1024)
                self.group = self.proc.pid
                output, _ = await asyncio.wait_for(self.proc.communicate(
                    json.dumps({'request': request, 'segments': segments, 'temp_dir': temp.name}).encode()), 28)
                if self.proc.returncode or len(output) > 3*1024*1024:
                    raise ValueError('exact_frame_unavailable')
                return json.loads(output)
            except (ValueError, OSError, asyncio.TimeoutError):
                raise HTTPException(503, 'recording_evidence_unavailable') from None
            finally:
                if self.group is not None:
                    try:
                        os.killpg(self.group, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                if self.proc and self.proc.returncode is None:
                    try:
                        await asyncio.wait_for(self.proc.wait(), 2)
                    except asyncio.TimeoutError:
                        pass  # proc stays registered; no new recovery until it exits.
                temp.cleanup()

def worker():
    import subprocess
    from .mp4_samples import read_video_samples
    from .sei_worker import packet_prefix_metadata
    body = json.loads(sys.stdin.buffer.read(65537))
    request = body['request']; validate_request(request)
    segments = body['segments']
    if not 0 < len(segments) <= 8:
        raise ValueError('segment_limit')
    hits = []
    for seg in segments:
        if seg['width'] != request['width'] or seg['height'] != request['height']:
            continue
        info, samples = read_video_samples(seg['path'])
        if len(samples) > 18000:
            raise ValueError('scan_limit')
        with open(seg['path'], 'rb', buffering=0) as handle:
            for sample in samples:
                if not 0 < sample.size <= 32*1024*1024 or sample.pos < 0:
                    raise ValueError('packet_bounds')
                payload = packet_prefix_metadata(handle, sample.pos, sample.size, info.length_size, info.codec == 'hevc')
                if matches(payload, request):
                    hits.append((seg, sample))
                    if len(hits) > 1:
                        raise ValueError('ambiguous_frame')
    if len(hits) != 1:
        raise ValueError('exact_frame_unavailable')
    seg, sample = hits[0]
    tool = os.environ.get('AINVR_RECORDING_FRAME_TOOL', '')
    if not tool or not os.path.isabs(tool):
        raise ValueError('hardware_tool_unavailable')
    with tempfile.TemporaryDirectory(prefix='frame-', dir=body.get('temp_dir', '/dev/shm')) as temp:
        dest = os.path.join(temp, 'frame.jpg')
        subprocess.run([tool, seg['path'], str(sample.pos), str(sample.pts), dest],
                       check=True, timeout=22, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(dest, 'rb') as image:
            data = image.read(1024*1024+1)
        if len(data) > 1024*1024 or not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
            raise ValueError('invalid_image')
        print(json.dumps({'jpeg_base64': base64.b64encode(data).decode(),
              'identity': request, 'provenance': {'kind': 'recording_exact_sei_v1',
              'segment_id': seg['id'], 'packet_position': sample.pos, 'recording_pts_ms': sample.pts*1000}}))

if __name__ == '__main__':
    worker()
