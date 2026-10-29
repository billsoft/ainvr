#!/usr/bin/env bash
# Manual bounded model smoke. Pauses only LLM if explicitly authorized below;
# restores its prior state. Core detection, recording and alarm storage continue.
set -euo pipefail
if [[ ${1:-} == --help ]]; then
  printf '%s\n' 'Usage: run-search-llm-smoke.sh --run-hardware --pause-llm-for-test --samples test/results/FILE.jsonl' \
    'Software preparation only: run-search-llm-smoke.sh --prepare-only --samples test/results/FILE.jsonl'
  exit 0
fi
task_prepare_only=0
if [[ $# == 3 && $1 == --prepare-only && $2 == --samples ]]; then
  task_prepare_only=1; task_samples_argument=$3
elif [[ $# == 4 && $1 == --run-hardware && $2 == --pause-llm-for-test && $3 == --samples ]]; then
  task_samples_argument=$4
else exit 64; fi
[[ $EUID == 0 ]] || { printf '%s\n' 'Run this explicit wrapper as root so fixture ownership can match the service.' >&2; exit 64; }
task_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
cd -- "$task_root"
umask 077
task_binary="$task_root/out/llm-search-software/native/ainvr_llm_search_bpu_smoke"
[[ $task_prepare_only == 1 || -x $task_binary ]] || exit 64
# Use the production service identity for shared residency state. A root test
# must never replace the registry with a root-only inode on service restore.
task_service_user=$(systemctl show ainvr-llm -p User --value)
[[ $task_service_user =~ ^[a-z_][a-z0-9_-]*$ && $task_service_user != root ]] || exit 64
task_service_group=$(id -gn "$task_service_user")
task_run="$(date -u +%Y%m%dT%H%M%SZ)_$$"
task_directory="$task_root/test/results/search-llm-smoke/$task_run"
mkdir -p -- "$task_root/test/results/search-llm-smoke"
chown "$task_service_user:$task_service_group" "$task_root/test/results/search-llm-smoke"
chmod 0700 "$task_root/test/results/search-llm-smoke"
mkdir -m 0700 -- "$task_directory"
# Copy bytes rather than altering permissions on historical source evidence.
# Opening every component relative to the trusted results root prevents a
# symlink/parent-directory switch from escaping the test evidence boundary.
python3 - "$task_root" "$task_samples_argument" "$task_directory" "$task_service_user" <<'PY'
import hashlib,json,os,pathlib,pwd,stat,sys
root=pathlib.Path(sys.argv[1]);base=root/'test/results';destination=pathlib.Path(sys.argv[3]);user=pwd.getpwnam(sys.argv[4])
anchor=os.open(base,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
dest=os.open(destination,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
dest_identity=os.fstat(dest)
if dest_identity.st_uid!=0:raise RuntimeError('smoke_fixture_destination_not_owned')
def read_source(value,maximum):
    path=pathlib.Path(os.path.abspath(value if os.path.isabs(value) else root/value))
    try:parts=path.relative_to(base).parts
    except ValueError:raise RuntimeError('smoke_fixture_path_outside_results')
    if not parts:raise RuntimeError('smoke_fixture_path_invalid')
    parent=os.dup(anchor)
    try:
        for name in parts[:-1]:
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=parent);os.close(parent);parent=child
        fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=parent)
        try:
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or not 0<before.st_size<=maximum:raise RuntimeError('smoke_fixture_size_or_type_invalid')
            chunks=[];remaining=before.st_size
            while remaining:
                chunk=os.read(fd,min(65536,remaining))
                if not chunk:raise RuntimeError('smoke_fixture_short_read')
                chunks.append(chunk);remaining-=len(chunk)
            extra=os.read(fd,1);after=os.fstat(fd)
            identity=lambda s:(s.st_dev,s.st_ino,s.st_size,s.st_mtime_ns,s.st_ctime_ns)
            if extra or identity(before)!=identity(after):raise RuntimeError('smoke_fixture_changed')
            return path,b''.join(chunks)
        finally:os.close(fd)
    finally:os.close(parent)
def write_owned(directory,name,data):
    fd=os.open(name,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,0o600,dir_fd=directory)
    try:
        os.fchown(fd,user.pw_uid,user.pw_gid);os.fchmod(fd,0o600)
        view=memoryview(data)
        while view:
            count=os.write(fd,view)
            if count<=0:raise RuntimeError('smoke_fixture_write_failed')
            view=view[count:]
        os.fsync(fd)
    finally:os.close(fd)
def unique(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise RuntimeError('smoke_duplicate_input_key')
        result[key]=value
    return result
try:
    source_path,source=read_source(sys.argv[2],16*16384);lines=source.decode('utf-8').splitlines()
    if not 1<=len(lines)<=16:raise RuntimeError('smoke_fixture_sample_count_invalid')
    images=destination/'images';os.mkdir('images',mode=0o700,dir_fd=dest)
    image_dir=os.open('images',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=dest)
    prepared=[];audit=[];ids=set()
    fields={'sample_id','jpeg_path','frame_id','query','kind','question_scope','expected_decision'}
    for index,line in enumerate(lines):
        if not line or len(line.encode())>16384:raise RuntimeError('smoke_fixture_line_invalid')
        row=json.loads(line,object_pairs_hook=unique)
        if not isinstance(row,dict) or set(row)!=fields or not isinstance(row['sample_id'],str) or row['sample_id'] in ids:raise RuntimeError('smoke_fixture_schema_invalid')
        ids.add(row['sample_id'])
        if not isinstance(row['jpeg_path'],str) or any(ord(c)<32 or ord(c)==127 for c in row['jpeg_path']):raise RuntimeError('smoke_fixture_path_invalid')
        original,data=read_source(row['jpeg_path'],8*1024*1024)
        name=f'{index:02d}.jpg';copied=images/name;digest=hashlib.sha256(data).hexdigest();write_owned(image_dir,name,data)
        audit.append({'sample_id':row['sample_id'],'source_path':str(original),'prepared_path':str(copied),'sha256':digest,'bytes':len(data)})
        row['jpeg_path']=str(copied);encoded=json.dumps(row,ensure_ascii=False,separators=(',',':')).encode()
        if len(encoded)>16384:raise RuntimeError('smoke_prepared_line_too_large')
        prepared.append(encoded+b'\n')
    data=b''.join(prepared)
    if len(data)>16*16384:raise RuntimeError('smoke_prepared_samples_too_large')
    write_owned(dest,'prepared.jsonl',data)
    record={'schema':'ainvr.search-smoke-fixtures.v1','source_jsonl':str(source_path),'source_jsonl_sha256':hashlib.sha256(source).hexdigest(),
            'prepared_jsonl_sha256':hashlib.sha256(data).hexdigest(),'sample_count':len(prepared),'images':audit,'source_modified':False}
    write_owned(dest,'fixture-audit.json',(json.dumps(record,ensure_ascii=False,indent=2)+'\n').encode())
    current=os.stat(destination,follow_symlinks=False)
    if (current.st_dev,current.st_ino)!=(dest_identity.st_dev,dest_identity.st_ino):raise RuntimeError('smoke_fixture_destination_changed')
    os.fchown(image_dir,user.pw_uid,user.pw_gid);os.close(image_dir)
    os.fchown(dest,user.pw_uid,user.pw_gid)
finally:os.close(dest);os.close(anchor)
PY
task_samples="$task_directory/prepared.jsonl"
runuser -u "$task_service_user" -- python3 - "$task_directory" <<'PY'
import hashlib,json,os,pathlib,sys
directory=pathlib.Path(sys.argv[1]);audit=json.loads((directory/'fixture-audit.json').read_text())
data=(directory/'prepared.jsonl').read_bytes()
assert hashlib.sha256(data).hexdigest()==audit['prepared_jsonl_sha256']
rows=[json.loads(line) for line in data.splitlines()]
assert len(rows)==audit['sample_count']
for row,item in zip(rows,audit['images']):
    assert row['jpeg_path']==item['prepared_path']
    with open(row['jpeg_path'],'rb') as source:image=source.read(8*1024*1024+1)
    assert len(image)==item['bytes'] and hashlib.sha256(image).hexdigest()==item['sha256']
path=directory/'write-preflight.tmp'
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
try:assert os.write(fd,b'preflight')==9;os.fsync(fd)
finally:os.close(fd)
path.unlink()
PY
printf 'Fixtures prepared and service-user read/write verified: %s\n' "$task_directory"
[[ $task_prepare_only == 0 ]] || exit 0
exec 9>test/results/search-hardware-integration.lock
flock -n 9 || { printf '%s\n' 'Another explicit hardware test is active.' >&2; exit 1; }
task_was_active=$(systemctl is-active ainvr-llm || true)
task_ai_active=$(systemctl is-active ainvr-ai || true)
task_probe_pid=''
task_probe_pgid=''
cleanup() {
  task_status=$?
  trap - EXIT INT TERM HUP
  if [[ -n $task_probe_pid ]] && kill -0 "$task_probe_pid" 2>/dev/null; then
    # This exact recorded child is our timeout/session leader, never a glob.
    if [[ $(tr '\0' ' ' </proc/"$task_probe_pid"/cmdline) == *"$task_binary"* ]]; then
      kill -TERM -- "-$task_probe_pgid" 2>/dev/null || true
      for ((task_n=0; task_n<40; ++task_n)); do
        kill -0 "$task_probe_pid" 2>/dev/null || break
        sleep .25
      done
      if kill -0 "$task_probe_pid" 2>/dev/null; then kill -KILL -- "-$task_probe_pgid" 2>/dev/null || true; fi
      wait "$task_probe_pid" 2>/dev/null || true
    else
      printf '%s\n' 'Owned probe identity changed; no unrelated process was killed.' >&2
      task_status=98
    fi
  fi
  if [[ $task_was_active == active ]]; then
    if ! systemctl start ainvr-llm; then task_status=99; fi
    task_ready=0
    for ((task_n=0; task_n<60; ++task_n)); do
      if curl -fsS --max-time 1 http://127.0.0.1:8300/health >"$task_directory/after-health.json.tmp" 2>/dev/null &&
          python3 -c 'import json,sys;sys.exit(0 if json.load(open(sys.argv[1])).get("ready") is True else 1)' "$task_directory/after-health.json.tmp"; then
        mv -- "$task_directory/after-health.json.tmp" "$task_directory/after-health.json"
        task_ready=1; break
      fi
      sleep 1
    done
    if [[ $task_ready != 1 ]]; then
      printf '%s\n' 'Original LLM service did not report ready after restore; inspect this run log.' >&2
      task_status=99
    fi
  fi
  if [[ $task_ai_active == active ]] && ! systemctl is-active --quiet ainvr-ai; then task_status=99; fi
  printf 'Search LLM smoke finished: exit=%s; original_llm_state=%s; report=%s\n' "$task_status" "$task_was_active" "$task_directory/report.json"
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
if [[ $task_was_active == active ]]; then
  curl -fsS --max-time 3 http://127.0.0.1:8300/health >"$task_directory/before-health.json"
  python3 -c 'import json,sys;sys.exit(0 if json.load(open(sys.argv[1])).get("ready") is True else 1)' "$task_directory/before-health.json"
  systemctl stop ainvr-llm
fi
sha256sum -- "$task_samples" >"$task_directory/samples.sha256"
setsid timeout --signal=TERM --kill-after=10 75 runuser -u "$task_service_user" -- "$task_binary" --run-bpu-search \
  --samples "$task_samples" --report "$task_directory/report.json" \
  --task-timeout-ms 20000 --total-timeout-ms 60000 >"$task_directory/probe.log" 2>&1 &
task_probe_pid=$!
task_probe_pgid=$task_probe_pid
if wait "$task_probe_pid"; then task_result=0; else task_result=$?; fi
task_probe_pid=''
printf 'Probe exit=%s; restoring original LLM state.\n' "$task_result"
exit "$task_result"
