#!/usr/bin/env python3
"""Finite GDC dimension registration probe; deliberately submits zero frames."""
import argparse
import fcntl
from pathlib import Path
from common import Experiment, ROOT

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--gdc-bin',required=True,
                   help='Known-good existing GDC binary; no frames will use it')
    args=p.parse_args()
    args.timeout=30
    if not Path(args.gdc_bin).is_file():
        p.error('GDC binary is missing')
    ROOT.joinpath('results').mkdir(exist_ok=True)
    with ROOT.joinpath('results/.run.lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        exp=Experiment('gdc_dimensions',args)
        binary=[]
        def build():
            binary.append(exp.build('gdc_dimension_probe',
                [ROOT/'native/gdc_dimension_probe.c'],['vpf','vio','cam','hbmem']))
            return {'scope':'Configuration only; never starts a flow or submits frames'}
        if exp.case('build',build)['status']=='PASS':
            def probe():
                result=exp.native(binary[0],Path(args.gdc_bin).resolve())
                events=[x for x in result['measurements'] if x.get('event')=='gdc_dimension_config']
                if len(events)!=21 or events[0]['return_code']!=0:
                    raise RuntimeError('Missing measurements or known-good control rejected')
                return {'measurements':events,
                        'scope':'API acceptance alone cannot verify processing support'}
            exp.case('dimension_registration',probe)
        raise SystemExit(exp.finish())

if __name__=='__main__':
    main()
