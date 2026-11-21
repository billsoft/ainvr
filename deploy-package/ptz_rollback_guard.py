"""Fail-closed console downgrade preflight. Does not mutate parameters or services."""
import json,os,subprocess
from pathlib import Path
LEGACY_COMPATIBILITY={'schema':1,'viewGuardVersion':1}
SCENE_COMPATIBILITY={**LEGACY_COMPATIBILITY,'sceneBindingVersion':1}
COMPATIBILITY={**SCENE_COMPATIBILITY,'presetBindingVersion':1}
MOTION_COMPATIBILITY={**COMPATIBILITY,'motionAdmissionVersion':1}
JOINT_PUBLISHER='Motion admission requires joint backend/alarm publication; use deploy-package/deploy_ptz_motion.py'
REQUIRED=('services/ptzGuardedSnapshot.js','services/ptzManager.js','routes/ptz.js')
SCENE_REQUIRED=('app.js','services/armingSceneRuntime.js','services/sceneCapture.js',
 'services/sceneProjection.js','services/floorPlanImages.js','store/armingScenes.js',
 'store/alarmArmingStore.js','routes/alarmArmingRoutes.js','store/migrations/032_arming_scenes.sql')
PRESET_REQUIRED=('services/presetHome.js','services/presetView.js','store/migrations/034_arming_preset_binding.sql')
MOTION_REQUIRED=('services/ptzMotionAdmission.js','store/physicalPtzGuards.js','store/migrations/036_ptz_motion_admission.sql')
def _regular(target,name):
 root=Path(target)
 file=root/name
 return file.is_file() and not any((root/Path(*Path(name).parts[:n])).is_symlink() for n in range(1,len(Path(name).parts)+1))

def _capabilities(target):
 target=Path(target)
 marker=target/'ptz-compatibility.json'
 has_motion_files=any(os.path.lexists(target/name) for name in MOTION_REQUIRED)
 if marker.is_symlink():raise RuntimeError('Invalid PTZ compatibility marker')
 if not marker.exists():
  if has_motion_files:raise RuntimeError('Missing motion compatibility marker. '+JOINT_PUBLISHER)
  return False,False,False,False
 try:document=json.loads(marker.read_text())
 except (ValueError,OSError):raise RuntimeError('Invalid PTZ compatibility marker') from None
 if not isinstance(document,dict) or document not in (LEGACY_COMPATIBILITY,SCENE_COMPATIBILITY,COMPATIBILITY,MOTION_COMPATIBILITY) or any(type(v)is not int for v in document.values()):
  raise RuntimeError('Invalid PTZ compatibility marker')
 motion=document.get('motionAdmissionVersion')==1
 if has_motion_files and not motion:raise RuntimeError('Stale motion compatibility marker. '+JOINT_PUBLISHER)
 if motion and not all(_regular(target,name) for name in MOTION_REQUIRED):
  raise RuntimeError('Motion-aware target is incomplete. '+JOINT_PUBLISHER)
 if not all(_regular(target,name) for name in REQUIRED):
  raise RuntimeError('PTZ-aware target is incomplete')
 scene=document.get('sceneBindingVersion')==1
 if scene and not all(_regular(target,name) for name in SCENE_REQUIRED):
  raise RuntimeError('Scene-aware target is incomplete')
 preset=document.get('presetBindingVersion')==1
 if preset and not all(_regular(target,name) for name in PRESET_REQUIRED):
  raise RuntimeError('Preset-aware target is incomplete')
 return True,scene,preset,motion

def capabilities(target):return _capabilities(target)[:3]
def supports_motion_admission(target):return _capabilities(target)[3]

def require_ordinary_release(root,target,alarm_src=None):
 if (supports_motion_admission(Path(root)/'srs-web-console/backend/dist') or supports_motion_admission(target)
     or (alarm_src is not None and os.path.lexists(Path(alarm_src)/'motion-admission.mjs'))):
  raise RuntimeError(JOINT_PUBLISHER)

def supports_view_guards(target):return capabilities(target)[0]
def supports_scene_bindings(target):return capabilities(target)[1]

def validate_state(state):
 if not isinstance(state,dict) or set(state)!={'blocked','stopPending','sceneBindings','presetBindings'} or any(type(n)is not int or n<0 for n in state.values()) or state['presetBindings']>state['sceneBindings']:
  raise RuntimeError('Invalid persistent PTZ protection response')
 return state

def database_state(root):
 node=os.environ.get('AINVR_NODE','/opt/node-v26.13.0-linux-arm64/bin/node')
 result=subprocess.run([node,str(Path(__file__).with_name('ptz-rollback-state.mjs')),str(root)],capture_output=True,text=True,timeout=15)
 if result.returncode:raise RuntimeError('Cannot verify persistent PTZ protection; downgrade refused')
 try:
  state=validate_state(json.loads(result.stdout))
 except (ValueError,TypeError):raise RuntimeError('Invalid persistent PTZ protection response') from None
 return state

def preflight(root,target,read_state=None):
 view,scene,preset=capabilities(target)
 # Even an older PTZ-aware target interprets canonical scene coordinates as live.
 # Always query the current DB; a legacy marker cannot authorize that downgrade.
 state=validate_state((read_state or database_state)(root))
 if state['presetBindings'] and not preset:
  raise RuntimeError('Downgrade refused: preset bindings exist; use a complete preset-aware release. Historical data was not changed.')
 if state['sceneBindings'] and not scene:
  raise RuntimeError('Downgrade refused: scene bindings exist; use a complete scene-aware release. Historical data was not changed.')
 if not view and (state['blocked'] or state['stopPending']):
  raise RuntimeError('Downgrade refused: restore/rearm every protected camera and confirm Stop, or use a PTZ-aware release. Historical data was not changed.')
