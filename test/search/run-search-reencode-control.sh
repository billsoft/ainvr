#!/usr/bin/env bash
# Explicit manual Node -> real AI HTTP -> JPU/GLES/BPU interface fixture.
# It never installs code or changes existing service/configuration state.
set -euo pipefail
[[ $# == 3 && $1 == --run-hardware && $2 == --inputs && $EUID == 0 ]] || { printf '%s\n' 'Usage (root): run-search-reencode-control.sh --run-hardware --inputs test/results/MANIFEST.json'; exit 64; }
task_inputs=$3
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
umask 077
exec 9>test/results/search-hardware-integration.lock
flock -n 9 || { printf '%s\n' 'Another owned hardware test is active.' >&2; exit 1; }
[[ -z $(ss -H -ltn '( sport = :25442 )') ]] || { printf '%s\n' 'Test port 25442 is occupied; no process was changed.' >&2; exit 1; }
task_binary="$task_root/test/build/search-hardware-ai/build/ai/ainvr_search_reencode_control_probe"
[[ -x $task_binary ]] || { printf '%s\n' 'Build the explicit reencode probe first.' >&2; exit 1; }
task_run="$(date -u +%Y%m%dT%H%M%SZ)_$$"
task_parent="$task_root/test/results/search-reencode-control"
[[ ! -L $task_parent ]] || exit 1
mkdir -p "$task_parent";chmod 0711 "$task_parent"
task_directory="$task_parent/$task_run"
mkdir -m 0700 "$task_directory"
task_pid=''
identities(){
 systemctl show ainvr-ai ainvr-llm ainvr-alarm ainvr-recorder ainvr-backend -p Id -p ActiveState -p MainPID -p ExecMainStartTimestampMonotonic
 docker inspect --format '{{.State.Pid}} {{.State.StartedAt}}' ainvr-srs
}
identities >"$task_directory/services-before.txt"
cleanup(){
  task_status=$?;trap - EXIT INT TERM
  if [[ -n $task_pid && -r /proc/$task_pid/cmdline ]]; then
    task_command=$(tr '\0' ' ' </proc/"$task_pid"/cmdline)
    if [[ $task_command != *"$task_binary --run-hardware --private-config $task_directory/fixture-config.json"* ]]; then
      printf '%s\n' 'Owned probe identity changed; no signal was sent.' >&2;exit 98
    fi
    kill -TERM "$task_pid" 2>/dev/null || true
    for ((task_n=0;task_n<450;++task_n));do kill -0 "$task_pid" 2>/dev/null || break;sleep .1;done
    if kill -0 "$task_pid" 2>/dev/null;then printf '%s\n' 'Probe did not drain; evidence retained for manual attention.' >&2;exit 98;fi
  fi
  if [[ -n $task_pid ]];then wait "$task_pid" 2>/dev/null||task_status=98;fi
  identities >"$task_directory/services-after.txt"||task_status=98
  cmp -s "$task_directory/services-before.txt" "$task_directory/services-after.txt"||task_status=98
  python3 - "$task_pid" >"$task_directory/residency-after.json" <<'PY' || task_status=98
import json,pathlib,sys
value=json.loads(pathlib.Path('/run/ainvr/bpu-reservations.json').read_text())
if sys.argv[1] and any(row.get('pid')==int(sys.argv[1]) for row in value.get('holders',[])):raise RuntimeError('owned_probe_reservation_not_released')
print(json.dumps({'owned_probe_reservation_released':True,'holders':[{'service':r.get('service'),'pid':r.get('pid'),'state':r.get('state')} for r in value.get('holders',[])]}))
PY
  if [[ $task_status == 0 ]];then printf '%s\n' '{"passed":true,"owned_probe_stopped":true,"original_service_identities_unchanged":true}' >"$task_directory/run-complete.json";fi
  printf 'Reencode control fixture exit=%s; results=%s\n' "$task_status" "$task_directory"
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
python3 - "$task_root" "$task_directory" "$task_inputs" <<'PY'
import hashlib,json,os,pathlib,pwd,secrets,stat,sys,uuid
root=pathlib.Path(sys.argv[1]);directory=pathlib.Path(sys.argv[2]);user=pwd.getpwnam('sunrise')
manifest_path=(root/sys.argv[3]).resolve(strict=True)
if not manifest_path.is_relative_to(root/'test/results') or not manifest_path.is_file() or manifest_path.stat().st_size>8192:raise RuntimeError('owned_input_manifest_required')
manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
if set(manifest)!={'schema_version','target','images'} or manifest['schema_version']!='search-reencode-control-inputs-v1':raise RuntimeError('invalid_input_manifest')
pin=manifest['target']
if set(pin)!={'package_id','package_sha256','model_version'} or pin['package_id']!='siglip2-base-full-int8' or len(pin['package_sha256'])!=64 or any(c not in '0123456789abcdef' for c in pin['package_sha256']) or pin['model_version']!='search-v1-'+pin['package_sha256']:raise RuntimeError('verified_target_pin_required')
if not isinstance(manifest['images'],list) or len(manifest['images'])!=2:raise RuntimeError('exactly_two_input_images_required')
def write(name,data):
 p=directory/name
 fd=os.open(p,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600)
 try:
  os.fchown(fd,user.pw_uid,user.pw_gid)
  with os.fdopen(fd,'wb',closefd=False) as f:f.write(data);f.flush();os.fsync(fd)
 finally:os.close(fd)
images=[]
for index,item in enumerate(manifest['images']):
 if set(item)!={'file','sha256','width','height'}:raise RuntimeError('invalid_input_image_metadata')
 name=f'input{index}';width=item['width'];height=item['height']
 if type(width) is not int or type(height) is not int or not 2<=width<=8192 or not 2<=height<=8192 or width*height>8*1024*1024:raise RuntimeError('bounded_input_dimensions_required')
 source=(root/item['file']).resolve(strict=True)
 if not (source.is_relative_to(root/'test/results') or source.is_relative_to(root/'test/runtime')):raise RuntimeError('owned_test_image_required')
 fd=os.open(source,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
 try:
  before=os.fstat(fd)
  if not stat.S_ISREG(before.st_mode) or not 4<=before.st_size<=8*1024*1024:raise RuntimeError('invalid_source_jpeg')
  with os.fdopen(fd,'rb',closefd=False) as f:data=f.read(8*1024*1024+1)
  if len(data)!=before.st_size or os.fstat(fd).st_mtime_ns!=before.st_mtime_ns:raise RuntimeError('source_jpeg_changed')
 finally:os.close(fd)
 if hashlib.sha256(data).hexdigest()!=item['sha256']:raise RuntimeError('input_image_hash_mismatch')
 write(name+'.jpg',data)
 images.append(dict(file=name+'.jpg',width=width,height=height,sha256=hashlib.sha256(data).hexdigest(),sample_id=str(uuid.uuid4()),source_fingerprint=hashlib.sha256(('test-source-'+name).encode()).hexdigest()))
inputs=dict(target=pin,job_id=str(uuid.uuid4()),
 payload_fingerprint=hashlib.sha256(json.dumps(images,sort_keys=True).encode()).hexdigest(),images=images)
write('inputs.json',(json.dumps(inputs)+'\n').encode())
write('fixture-config.json',(json.dumps(dict(schema_version='search-reencode-control-fixture-v1',listen_port=25442,api_token=secrets.token_hex(24)))+'\n').encode())
os.chown(directory,user.pw_uid,user.pw_gid)
PY
setpriv --reuid=sunrise --regid=sunrise --init-groups env HOME=/home/sunrise USER=sunrise LOGNAME=sunrise \
  "$task_binary" --run-hardware --private-config "$task_directory/fixture-config.json" >"$task_directory/probe.log" 2>&1 &
task_pid=$!
task_ready=0
for ((task_n=0;task_n<100;++task_n));do
  if curl -fsS --max-time 1 http://127.0.0.1:25442/livez >/dev/null 2>&1;then task_ready=1;break;fi
  kill -0 "$task_pid" 2>/dev/null||break;sleep .1
done
[[ $task_ready == 1 ]]||{ printf '%s\n' 'Owned probe did not become live.' >&2;exit 1; }
timeout 80 setpriv --reuid=sunrise --regid=sunrise --init-groups env HOME=/home/sunrise USER=sunrise LOGNAME=sunrise \
  /opt/ainvr/node-v24.20.0-linux-arm64/bin/node --import "$task_root/srs-web-console/backend/node_modules/tsx/dist/loader.mjs" \
  "$task_root/test/search/reencode_control_steps.mts" --run-hardware "$task_directory"
