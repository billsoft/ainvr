#!/usr/bin/env python3
"""Read-only S100P runtime/recording audit. No credentials in evidence output."""
import argparse
import datetime
import json
from pathlib import Path
import sqlite3
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[2]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--since', required=True, help='Local ISO timestamp, e.g. 2026-10-13T12:00:00')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    cutoff = datetime.datetime.fromisoformat(args.since)
    if args.output.exists():
        parser.error('Use a new output file')
    report = {'at': datetime.datetime.now().isoformat(), 'since': args.since}
    def command(*cmd):
        return subprocess.check_output(cmd, text=True, timeout=30)
    units = command('systemctl', 'list-units', '--all', '--type=service', 'ainvr-*', '--no-legend')
    report['services'] = {}
    for unit in [line.split()[0] for line in units.splitlines() if line.strip()]:
        state = command('systemctl', 'show', unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'NRestarts')
        warnings = []
        for line in command('journalctl', '-u', unit, '--since', cutoff.isoformat(sep=' '), '-o', 'json', '--no-pager').splitlines():
            try:
                entry = json.loads(json.loads(line).get('MESSAGE', ''))
                if entry.get('level') in ('ERROR', 'WARNING', 'WARN', 'CRITICAL'):
                    # Only categorize logs; do not export potentially private message text.
                    warnings.append({'level': entry['level'], 'module': entry.get('module'), 'ts': entry.get('ts')})
            except (ValueError, TypeError, AttributeError):
                pass
        report['services'][unit] = {'state': state, 'warnings': warnings}
    report['containers'] = {}
    for name in ('ainvr-mongo', 'ainvr-postgres', 'ainvr-srs'):
        info = json.loads(command('docker', 'inspect', name))[0]
        report['containers'][name] = {'status': info['State']['Status'], 'oom': info['State']['OOMKilled'],
                                       'restarts': info['RestartCount']}
    cfg = json.loads((ROOT/'deploy/s100p/runtime/ai-service.json').read_text())
    def get(path):
        request = urllib.request.Request('http://127.0.0.1:8000'+path, headers={'x-api-key': cfg['server']['api_key']})
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.load(response)
    report['channels'] = []
    for channel in get('/api/v1/channels')['channels']:
        stats = channel['stats']; pub = stats.get('publish') or {}
        overview = get('/api/v1/channels/'+channel['id']+'/snapshots/overview')
        report['channels'].append({'id': channel['id'], 'state': stats.get('state'),
            'inference_fps': stats.get('inference_fps_actual'), 'has_error': bool(stats.get('last_error')),
            'publish_reconnects': pub.get('reconnect_count'), 'buffer': pub.get('buffer'),
            'archive': overview.get('archive_stats'), 'retained': overview.get('count')})
    db = ROOT/'data/recorder/segments.db'
    connection = sqlite3.connect('file:'+str(db)+'?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    rows = list(connection.execute('SELECT * FROM segments WHERE start_ts>=? ORDER BY channel_id,start_ts', (int(cutoff.timestamp()*1000),)))
    config = json.loads((ROOT/'data/recorder/config.json').read_text())
    storage = config['recording']['storage']
    recording = Path(storage['localPath']) if storage['kind']=='local' else None
    previous = {}; missing = []; mismatch = []; gaps = []
    for row in rows:
        if recording:
            path = recording/row['rel_path']
            if not path.is_file(): missing.append(row['rel_path'])
            elif row['complete'] and path.stat().st_size != row['size_bytes']: mismatch.append(row['rel_path'])
        old = previous.get(row['channel_id'])
        if old and row['start_ts']-old['end_ts']>500:
            gaps.append({'channel': row['channel_id'], 'gap_ms': row['start_ts']-old['end_ts']})
        previous[row['channel_id']] = row
    report['recording'] = {'index': str(db.resolve()), 'quick_check': connection.execute('PRAGMA quick_check').fetchone()[0],
        'segments': len(rows), 'file_checks_available': recording is not None, 'missing': missing, 'size_mismatch': mismatch,
        'gaps_over_500ms': gaps, 'drop_events': [dict(r) for r in connection.execute('SELECT * FROM drop_events WHERE start_ts>=?',(int(cutoff.timestamp()*1000),))]}
    connection.close()
    report['disk'] = command('df', '-h', '/', '/mnt/ainvr-ssd')
    report['journal_disk'] = command('journalctl', '--disk-usage')
    report['text_log_bytes'] = {str(p):p.stat().st_size for p in (Path('/var/log/syslog'),Path('/var/log/kern.log'))}
    report['limitations'] = ['No full historical frame decode; no proof of every source frame inferred.',
        'Retention removes old records by policy; service counters reset on restart.',
        'Warning counts inspect retained structured service journal messages only; kernel/SRS incident root cause requires separate logs.']
    with args.output.open('x') as out:
        json.dump(report,out,ensure_ascii=False,indent=2)
    print(args.output)

if __name__ == '__main__':
    main()
