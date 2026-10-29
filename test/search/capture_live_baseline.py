#!/usr/bin/env python3
"""Bounded, read-only production observations; never configures a channel.

Credentials stay in memory. Only numeric timing/counters and opaque channel
identities are saved; no URLs, labels, boxes, images or raw configuration.
This is observed coexistence evidence, not a matched-input causal benchmark.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parents[2]
MAX_BYTES = 2 * 1024 * 1024
MAX_FRAMES = 12000
STOP = False
READS = []


def stop(_signum, _frame):
    global STOP
    STOP = True


def numeric(value, depth=0):
    if depth > 4:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)) and math.isfinite(value):
        return value
    if isinstance(value, dict) and len(value) <= 128:
        return {str(k)[:96]: number for k, v in value.items()
                if (number := numeric(v, depth + 1)) is not None}
    return None


def read_json(url, key=None):
    headers = {'Accept': 'application/json'}
    if key is not None:
        headers['x-api-key'] = key
    request = urllib.request.Request(url, headers=headers, method='GET')
    began, started, size, status = time.monotonic(), round(time.time() * 1000), 0, None
    path = urllib.parse.urlsplit(url).path
    category = 'channels' if path.endswith('/channels') else 'results' if path.endswith('/results') else 'srs'
    try:
        with urllib.request.urlopen(request, timeout=4) as response:
            status = response.status
            if status != 200:
                raise ValueError('read_status')
            data = response.read(MAX_BYTES + 1)
            size = len(data)
            if size > MAX_BYTES:
                raise ValueError('read_capacity')
            return json.loads(data)
    except urllib.error.HTTPError as error:
        status = error.code
        raise
    finally:
        if len(READS) < 4000:
            READS.append({'category': category, 'started_at_ms': started, 'status': status,
                          'duration_ms': 1000 * (time.monotonic() - began), 'response_bytes': size})


def identities():
    units = ['ainvr-ai', 'ainvr-llm', 'ainvr-recorder', 'ainvr-alarm', 'ainvr-backend']
    output = subprocess.run(['systemctl', 'show', *units, '--property=Id,MainPID,ActiveState,ExecMainStartTimestampMonotonic'],
                            check=True, capture_output=True, text=True, timeout=5).stdout
    return output.strip()


def percentile(values, fraction):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(fraction * len(ordered)) - 1)] if ordered else None


def summary(frames):
    ordered = sorted(frames.values(), key=lambda row: (row['timestamp'], row['frame_index']))
    gaps = [1000 * (b['timestamp'] - a['timestamp']) for a, b in zip(ordered, ordered[1:])
            if b['timestamp'] > a['timestamp']]
    infer = [row['timing_ms']['inference'] for row in ordered if 'inference' in row['timing_ms']]
    total = [row['timing_ms']['total'] for row in ordered if 'total' in row['timing_ms']]
    elapsed = ordered[-1]['timestamp'] - ordered[0]['timestamp'] if len(ordered) > 1 else 0
    return {'observed_results': len(ordered), 'result_publication_span_seconds': elapsed,
            'observed_results_per_second': (len(ordered) - 1) / elapsed if elapsed > 0 else None,
            'publication_gap_ms_p95': percentile(gaps, .95), 'publication_gap_ms_max': max(gaps) if gaps else None,
            'reported_inference_mean_ms_p95': percentile(infer, .95), 'reported_total_mean_ms_p95': percentile(total, .95)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--duration', type=int, default=30)
    parser.add_argument('--interval', type=float, default=1.0)
    parser.add_argument('--label', choices=['baseline', 'search-load', 'recovery'], default='baseline')
    args = parser.parse_args()
    if not 10 <= args.duration <= 300 or not .5 <= args.interval <= 5:
        parser.error('duration must be 10..300 seconds; interval .5..5 seconds')
    os.umask(0o077)
    parent = ROOT / 'test/results/search-live-observations'
    if parent.is_symlink():
        raise ValueError('unsafe_result_parent')
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not parent.resolve().is_relative_to((ROOT / 'test/results').resolve()):
        raise ValueError('unsafe_result_parent')
    tag = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '_' + str(os.getpid())
    output = parent / (tag + '.json')
    config = json.loads((ROOT / 'deploy/s100p/runtime/ai-service.json').read_text())
    key = config.get('server', {}).get('api_key')
    port = config.get('server', {}).get('port', 8000)
    if not isinstance(key, str) or not 32 <= len(key) <= 512 or key.startswith('${') or '\n' in key or '\r' in key:
        raise ValueError('local_ai_credential_unavailable')
    if not isinstance(port, int) or not 1 <= port <= 65535:
        raise ValueError('local_ai_port_invalid')
    base = 'http://127.0.0.1:' + str(port)
    before = identities()
    rows = read_json(base + '/api/v1/channels', key).get('channels')
    if not isinstance(rows, list) or len(rows) > 1024:
        raise ValueError('channel_contract_invalid')
    selected = [row['id'] for row in rows if row.get('state') == 'running'][:4]
    if not selected:
        raise ValueError('no_running_ai_channel')
    for channel in selected:
        if not isinstance(channel, str) or not 1 <= len(channel) <= 128:
            raise ValueError('channel_identity_invalid')
    seen = {channel: set() for channel in selected}
    frames = {channel: {} for channel in selected}
    samples, errors, overflow = [], [], False
    started = time.time()
    began = time.monotonic()
    deadline, next_poll = began + args.duration, began
    first = True
    while time.monotonic() < deadline and not STOP:
        sample = {'elapsed_seconds': time.monotonic() - began, 'channels': []}
        try:
            channels = read_json(base + '/api/v1/channels', key).get('channels', [])
            for channel in selected:
                row = next((item for item in channels if item.get('id') == channel), None)
                if row is None:
                    sample['channels'].append({'channel_id': channel, 'state': 'missing'})
                    continue
                state = row.get('state')
                sample['channels'].append({'channel_id': channel,
                    'state': state if state in ['running', 'idle', 'reconnecting', 'error', 'stopped', 'starting'] else 'other',
                    'stats': numeric(row.get('stats', {}))})
                recent = read_json(base + '/api/v1/channels/' + urllib.parse.quote(channel, safe='') + '/results?limit=64', key)
                results = recent.get('results')
                if not isinstance(results, list) or len(results) > 64:
                    raise ValueError('results_contract_invalid')
                for result in results:
                    index, at = result.get('frame_index'), result.get('timestamp')
                    if not isinstance(index, int) or not isinstance(at, (int, float)) or not math.isfinite(at):
                        raise ValueError('frame_contract_invalid')
                    identity = (index, at)
                    if identity in seen[channel]:
                        continue
                    seen[channel].add(identity)
                    if first:
                        continue
                    if len(frames[channel]) >= MAX_FRAMES:
                        overflow = True
                        continue
                    frames[channel][identity] = {'frame_index': index, 'timestamp': at,
                        'frame_pts_ns': str(result.get('frame_pts_ns', ''))[:24],
                        'timing_ms': numeric(result.get('timing_ms', {})) or {}}
            srs = read_json('http://127.0.0.1:1985/api/v1/streams/')
            sample['srs_streams'] = [{'identity_sha256': hashlib.sha256(json.dumps([s.get('app'), s.get('name')]).encode()).hexdigest(),
                                      'clients': s.get('clients') if isinstance(s.get('clients'), int) else None,
                                      'numeric_counters': numeric(s)} for s in srs.get('streams', [])[:256]]
        except (ValueError, urllib.error.URLError, OSError, TimeoutError) as error:
            errors.append({'elapsed_seconds': time.monotonic() - began, 'kind': type(error).__name__,
                           'status': error.code if isinstance(error, urllib.error.HTTPError) else None})
        samples.append(sample)
        first = False
        next_poll += args.interval
        time.sleep(max(0, min(next_poll, deadline) - time.monotonic()))
    after = identities()
    report = {'schema_version': 'search-live-observations-v2', 'label': args.label, 'started_at_ms': round(started * 1000),
        'duration_seconds': time.monotonic() - began, 'read_only': True, 'configuration_changed': False,
        'matched_input_comparison': False, 'recording_segment_continuity_verified': False,
        'actual_per_frame_inference_p95_verified': False,
        'result_timestamp_semantics': 'postprocess_wall_clock_not_capture_time',
        'result_timing_semantics': 'rolling_mean_200_not_per_frame_latency',
        'original_service_identities_unchanged': before == after, 'frame_capacity_reached': overflow,
        'scope': 'Current live input; no images/labels/boxes/URLs/credentials retained. Result timestamps describe publication; timing_ms values are rolling means, not independent per-frame samples. Stats retain server-declared window percentiles. Observer HTTP cost is recorded, not assumed negligible.',
        'reads': READS, 'samples': samples, 'errors': errors, 'channels': [{'channel_id': channel, 'summary': summary(rows),
            'frames': list(rows.values())} for channel, rows in frames.items()]}
    data = json.dumps(report, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode()
    if len(data) > 8 * 1024 * 1024:
        raise ValueError('report_capacity')
    with output.open('xb') as handle:
        handle.write(data)
    print(json.dumps({'report': str(output.relative_to(ROOT)), 'errors': len(errors),
        'original_service_identities_unchanged': before == after,
        'channels': [{k: v for k, v in row.items() if k != 'frames'} for row in report['channels']]}, ensure_ascii=False))
    return 0 if not errors and before == after and not overflow else 1


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        raise SystemExit(main())
    except Exception as error:
        print(json.dumps({'error': type(error).__name__, 'detail': 'Read-only observations failed; no configuration was changed.'}))
        raise SystemExit(1)
