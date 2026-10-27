#!/usr/bin/env python3
"""Mounted SSD policy shared with the coordinated production publisher."""
import argparse
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deploy_ptz_release import require_ssd, prune, BACKUPS

def check(path):
 require_ssd()
 bucket = BACKUPS / 'gb28181'
 if path.is_symlink() or path.resolve(strict=True).parent != bucket.resolve():
  raise ValueError('Rollback must be a direct GB backup on the mounted SSD')
 # Coordinated release backups require its coordinated rollback entrypoint.
 if not (path/'repository').is_file() or not (path/'opt/ainvr/gb28181').is_dir():
  raise ValueError('Not a standalone GB backup; use deploy_ptz_release.py for coordinated releases')
 for unit in ['ainvr-gb28181','ainvr-gb-media']:
  if not (path/(unit+'.active')).is_file(): raise ValueError('Missing service state')
 for p in path.rglob('*'):
  if p.is_symlink(): raise ValueError('Rollback backup contains a symbolic link')

def main():
 parser=argparse.ArgumentParser();g=parser.add_mutually_exclusive_group(required=True)
 g.add_argument('--prepare',action='store_true');g.add_argument('--prune',action='store_true');g.add_argument('--check',type=Path)
 a=parser.parse_args()
 if a.check: check(a.check);return
 require_ssd();(BACKUPS/'gb28181').mkdir(mode=0o700,exist_ok=True)
 prune('gb28181')
if __name__=='__main__':main()
