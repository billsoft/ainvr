"""Bounded exact-frame recovery; never infer frame identity from wall time alone."""
import asyncio
import base64
import json
import os
import signal
import sys
import tempfile
import struct
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
    if 'source_frame_index' in body and (not isinstance(body['source_frame_index'], str)
            or not body['source_frame_index'].isdigit() or len(body['source_frame_index']) > 20
            or str(int(body['source_frame_index'])) != body['source_frame_index']):
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


def recovery_geometry(payload, request, encoded_width, encoded_height):
    """Cross-resolution evidence needs a same-packet, producer-issued full-frame proof.

    Aspect ratio alone is not a proof: cropped/reprojected or legacy resized images
    remain unavailable. Old same-resolution recordings retain the existing path.
    """
    actual = [encoded_width, encoded_height]
    observed = [request['width'], request['height']]
    if any(type(v) is not int or not 32 <= v <= 8192 for v in actual):
        raise ValueError('recording_geometry_unverified')
    extra = payload.get('model_extra')
    proof = extra.get('recording_evidence_geometry') if isinstance(extra, dict) else None
    if proof is None and actual == observed:
        return {'schema': 'recording-frame-geometry-v1', 'method': 'same_dimensions',
                'observation_size': observed, 'encoded_size': actual}
    if (not isinstance(proof, dict) or proof.get('schema') != 'recording-frame-geometry-v1'
            or proof.get('method') != 'full_frame_axis_scale'
            or proof.get('observation_size') != observed or proof.get('encoded_size') != actual
            or not isinstance(request.get('source_frame_index'), str)
            or proof.get('source_frame_index') != request['source_frame_index']
            or encoded_width * request['height'] != encoded_height * request['width']
            or encoded_width > request['width'] or encoded_height > request['height']):
        raise ValueError('recording_geometry_unverified')
    return {'schema': proof['schema'], 'method': proof['method'], 'observation_size': observed,
            'encoded_size': actual, 'source_frame_index': proof['source_frame_index']}


def jpeg_dimensions(data):
    """Read JPEG metadata only; pixel decoding remains in the hardware helper."""
    pos = 2
    while pos + 4 <= len(data):
        if data[pos] != 255:
            break
        while pos < len(data) and data[pos] == 255:
            pos += 1
        if pos >= len(data):
            break
        marker = data[pos]; pos += 1
        if marker in (0xda, 0xd9):
            break
        if marker == 1 or 0xd0 <= marker <= 0xd7:
            continue
        if pos + 2 > len(data):
            break
        size = int.from_bytes(data[pos:pos + 2], 'big')
        if size < 2 or pos + size > len(data):
            break
        if marker == 0xc0 and size >= 8:
            height, width = struct.unpack_from('>HH', data, pos + 3)
            return width, height
        pos += size
    raise ValueError('invalid_image')


_ERROR_STATUS = {'recording_not_found': 404, 'exact_frame_unavailable': 404,
                 'recording_geometry_unverified': 409, 'ambiguous_frame': 409,
                 'scan_limit': 503, 'packet_bounds': 503, 'segment_limit': 503,
                 'hardware_tool_unavailable': 503, 'hardware_frame_unavailable': 503,
                 'invalid_image': 503, 'recording_recovery_timeout': 504}

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
                if len(output) > 3*1024*1024:
                    raise ValueError('exact_frame_unavailable')
                result = json.loads(output)
                if isinstance(result, dict) and result.get('error') in _ERROR_STATUS:
                    raise HTTPException(_ERROR_STATUS[result['error']], result['error'])
                if self.proc.returncode:
                    raise ValueError('exact_frame_unavailable')
                return result
            except asyncio.TimeoutError:
                raise HTTPException(504, 'recording_recovery_timeout') from None
            except (ValueError, OSError):
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
    geometry_rejected = False
    matched_packets = 0
    for seg in segments:
        info, samples = read_video_samples(seg['path'])
        if len(samples) > 18000:
            raise ValueError('scan_limit')
        with open(seg['path'], 'rb', buffering=0) as handle:
            for sample in samples:
                if not 0 < sample.size <= 32*1024*1024 or sample.pos < 0:
                    raise ValueError('packet_bounds')
                payload = packet_prefix_metadata(handle, sample.pos, sample.size, info.length_size, info.codec == 'hevc')
                if matches(payload, request):
                    matched_packets += 1
                    if matched_packets > 1:
                        raise ValueError('ambiguous_frame')
                    try:
                        geometry = recovery_geometry(payload, request, info.width, info.height)
                    except ValueError:
                        geometry_rejected = True
                        continue
                    hits.append((seg, sample, geometry))
    if len(hits) != 1:
        raise ValueError('recording_geometry_unverified' if geometry_rejected else 'exact_frame_unavailable')
    seg, sample, geometry = hits[0]
    tool = os.environ.get('AINVR_RECORDING_FRAME_TOOL', '')
    if not tool or not os.path.isabs(tool):
        raise ValueError('hardware_tool_unavailable')
    with tempfile.TemporaryDirectory(prefix='frame-', dir=body.get('temp_dir', '/dev/shm')) as temp:
        dest = os.path.join(temp, 'frame.jpg')
        try:
            subprocess.run([tool, seg['path'], str(sample.pos), str(sample.pts), dest],
                           check=True, timeout=22, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (subprocess.SubprocessError, OSError):
            raise ValueError('hardware_frame_unavailable') from None
        with open(dest, 'rb') as image:
            data = image.read(1024*1024+1)
        if len(data) > 1024*1024 or not data.startswith(b'\xff\xd8') or not data.endswith(b'\xff\xd9'):
            raise ValueError('invalid_image')
        image_width, image_height = jpeg_dimensions(data)
        encoded_width, encoded_height = geometry['encoded_size']
        if (min(image_width, image_height) < 32 or image_width > encoded_width or image_height > encoded_height or
                abs(image_width / encoded_width - image_height / encoded_height) > 2 / min(encoded_width, encoded_height)):
            raise ValueError('recording_geometry_unverified')
        geometry.update(jpeg_size=[image_width, image_height], source_rectangle=[0, 0, *geometry['observation_size']])
        print(json.dumps({'jpeg_base64': base64.b64encode(data).decode(),
              'identity': request, 'provenance': {'kind': 'recording_exact_sei_v1',
              'segment_id': seg['id'], 'packet_position': sample.pos, 'recording_pts_ms': sample.pts*1000,
              'geometry': geometry}}))

if __name__ == '__main__':
    try:
        worker()
    except Exception as error:
        # No file path, credentials, SDK output or exception text crosses this boundary.
        code = str(error) if str(error) in _ERROR_STATUS else 'recording_evidence_unavailable'
        print(json.dumps({'error': code}))
        sys.exit(1)
