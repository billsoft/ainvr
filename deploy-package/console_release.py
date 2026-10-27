#!/usr/bin/env python3
"""Retired console entrypoint: refuses mutations before touching production."""
import argparse,json
from pathlib import Path
from release_common import validate

def apply(candidate):
 raise RuntimeError('Legacy publisher retired; use deploy_ptz_release.py --apply')
def restore(backup):
 raise RuntimeError('Legacy rollback retired; use deploy_ptz_release.py --rollback')
def main():
 p=argparse.ArgumentParser(description=__doc__)
 mode=p.add_mutually_exclusive_group(required=True)
 mode.add_argument('--check',type=Path);mode.add_argument('--apply',type=Path);mode.add_argument('--rollback',type=Path)
 a=p.parse_args()
 if a.check:print(json.dumps({'verified':True,'candidate':str(validate(a.check))}));return
 apply(a.apply) if a.apply else restore(a.rollback)
if __name__=='__main__':main()
