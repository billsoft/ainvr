#!/usr/bin/env python3
"""Cutover selection for the memory review spool: keep only what a consumer can still need."""
import importlib.util, os, pwd, sys, tempfile, time
from pathlib import Path

spec = importlib.util.spec_from_file_location('spool', Path(__file__).resolve().parents[2] / 'deploy-package/review-spool-memory-s100.py')
spool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(spool)


def frame(d, key, age, ack=False, pin=None, channel='live'):
    for ext, data in (('.json', ('{"channel_id":"%s"}' % channel).encode()), ('.jpg', b'\xff\xd8x\xff\xd9')):
        p = d / (key + ext)
        p.write_bytes(data)
        os.utime(p, (time.time() - age, time.time() - age))
    if ack:
        (d / (key + '.ack')).write_bytes(b'')
    if pin:
        if not (d / '.pin-anchor').exists():
            (d / '.pin-anchor').write_text('1')
        os.link(d / '.pin-anchor', d / f'{key}.{pin}.0.pin')


with tempfile.TemporaryDirectory(dir='/mnt/ainvr-ssd/ainvr-tests') as root:
    src, dst = Path(root, 'src'), Path(root, 'dst')
    src.mkdir()
    dst.mkdir()
    k = lambda c: c * 64
    frame(src, k('a'), 5)                        # in flight: kept
    frame(src, k('b'), 5, ack=True)              # consumed: dropped
    frame(src, k('c'), 4 * 86400)                # orphan of a deleted channel: dropped
    frame(src, k('d'), 4 * 86400, ack=True, pin='e' * 64)  # checkpoint-owned, captured channel: kept
    # Pinned by a channel deleted days ago (189: 16 stress-test channels left 114k pins).
    frame(src, k('f'), 4 * 86400, ack=True, pin='9' * 64, channel='deleted')
    frame(src, k('g'), 60, pin='8' * 64, channel='deleted')  # recently pinned: kept whatever the channel
    report = spool.migrate(src, dst, pwd.getpwuid(os.getuid()), captured={'live'})
    names = sorted(os.listdir(dst))
    assert report['frames'] == 3 and report['pinned'] == 2 and report['left_behind'] == 3, report
    assert k('g') + '.jpg' in names and f"{k('g')}.{'8' * 64}.0.pin" in names, names
    assert not any(n.startswith(k('f')) for n in names), 'stale pin of a deleted channel was migrated'
    names = [n for n in names if not n.startswith(k('g'))]
    assert {k('a') + '.jpg', k('a') + '.json', k('d') + '.jpg', k('d') + '.json', '.pin-anchor', f"{k('d')}.{'e' * 64}.0.pin"} == set(names), names
    every = Path(root, 'all')
    every.mkdir()
    # Without a readable capture list nothing is judged stale: every pinned frame is kept.
    assert spool.migrate(src, every, pwd.getpwuid(os.getuid()), captured=None)['frames'] == 4
    assert len(os.listdir(every)) == 4 * 2 + 1 + 3, sorted(os.listdir(every))
    assert not any(n.endswith('.ack') for n in names), 'ACKs belong to the old spool'
    assert os.stat(dst / '.pin-anchor').st_ino == os.stat(dst / f"{k('d')}.{'e' * 64}.0.pin").st_ino, 'pins must link the new anchor'
print('review spool cutover selection passed')
