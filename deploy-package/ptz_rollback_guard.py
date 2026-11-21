"""Fail-closed console downgrade preflight. Does not mutate parameters or services."""
import json,os,subprocess
from pathlib import Path
LEGACY_COMPATIBILITY={'schema':1,'viewGuardVersion':1}
SCENE_COMPATIBILITY={**LEGACY_COMPATIBILITY,'sceneBindingVersion':1}
COMPATIBILITY={**SCENE_COMPATIBILITY,'presetBindingVersion':1}
REQUIRED=('services/ptzGuardedSnapshot.js','services/ptzManager.js','routes/ptz.js')
SCENE_REQUIRED=('app.js','services/armingSceneRuntime.js','services/sceneCapture.js',
 'services/sceneProjection.js','services/floorPlanImages.js','store/armingScenes.js',
 'store/alarmArmingStore.js','routes/alarmArmingRoutes.js','store/migrations/032_arming_scenes.sql')
PRESET_REQUIRED=('services/presetHome.js','services/presetView.js','store/migrations/034_arming_preset_binding.sql')
def _regular(target,name):
 root=Path(target)
 file=root/name
 return file.is_file() and not any((root/Path(*Path(name).parts[:n])).is_symlink() for n in range(1,len(Path(name).parts)+1))

def capabilities(target):
 marker=Path(target)/'ptz-compatibility.json'
 if marker.is_symlink():raise RuntimeError('Invalid PTZ compatibility marker')
 if not marker.exists():return False,False,False
 try:document=json.loads(marker.read_text())
 except (ValueError,OSError):raise RuntimeError('Invalid PTZ compatibility marker') from None
 if not isinstance(document,dict) or document not in (LEGACY_COMPATIBILITY,SCENE_COMPATIBILITY,COMPATIBILITY) or any(type(v)is not int for v in document.values()):
  raise RuntimeError('Invalid PTZ compatibility marker')
 if not all(_regular(target,name) for name in REQUIRED):
  raise RuntimeError('PTZ-aware target is incomplete')
 scene=document.get('sceneBindingVersion')==1
 if scene and not all(_regular(target,name) for name in SCENE_REQUIRED):
  raise RuntimeError('Scene-aware target is incomplete')
 preset=document.get('presetBindingVersion')==1
 if preset and not all(_regular(target,name) for name in PRESET_REQUIRED):
  raise RuntimeError('Preset-aware target is incomplete')
 return True,scene,preset

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
