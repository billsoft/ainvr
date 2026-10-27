"""Fail-closed console downgrade preflight. Does not mutate parameters or services."""
import json,os,subprocess
from pathlib import Path
COMPATIBILITY={'schema':1,'viewGuardVersion':1}
REQUIRED=('services/ptzGuardedSnapshot.js','services/ptzManager.js','routes/ptz.js')
def supports_view_guards(target):
 marker=Path(target)/'ptz-compatibility.json'
 if not marker.exists():return False
 if marker.is_symlink() or json.loads(marker.read_text())!=COMPATIBILITY:
  raise RuntimeError('Invalid PTZ compatibility marker')
 if not all((Path(target)/name).is_file() and not (Path(target)/name).is_symlink() for name in REQUIRED):
  raise RuntimeError('PTZ-aware target is incomplete')
 return True

def database_state(root):
 node=os.environ.get('AINVR_NODE','/opt/ainvr/node-v24.20.0-linux-arm64/bin/node')
 result=subprocess.run([node,str(Path(__file__).with_name('ptz-rollback-state.mjs')),str(root)],capture_output=True,text=True,timeout=15)
 if result.returncode:raise RuntimeError('Cannot verify persistent PTZ protection; downgrade refused')
 try:
  state=json.loads(result.stdout)
  if set(state)!={'blocked','stopPending'} or any(type(n)is not int or n<0 for n in state.values()):raise ValueError()
 except (ValueError,TypeError):raise RuntimeError('Invalid persistent PTZ protection response') from None
 return state

def preflight(root,target,read_state=None):
 if supports_view_guards(target):return
 state=(read_state or database_state)(root)
 if state['blocked'] or state['stopPending']:
  raise RuntimeError('Downgrade refused: restore/rearm every protected camera and confirm Stop, or use a PTZ-aware release. Historical data was not changed.')
