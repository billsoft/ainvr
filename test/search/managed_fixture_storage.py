#!/usr/bin/env python3
"""Explicit test-owned SSD namespace only; never called by software preflight."""
import json,os,re,stat,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'shared/os-helper'))
import storage
MAX_FILES=256
MAX_BYTES=32*1024*1024
CAPACITY_MONGO_BYTES=2*1024*1024*1024
CAPACITY_INDEX_BYTES=256*1024*1024
VOLUME='64a5b078-4c84-4766-9bc6-68c247294079'

def private_json(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        s=os.fstat(fd)
        if not stat.S_ISREG(s.st_mode)or s.st_uid!=os.geteuid()or s.st_nlink!=1 or s.st_mode&0o077 or s.st_size>65536:raise ValueError('private_fixture_file_required')
        return json.loads(os.read(fd,65537))
    finally:os.close(fd)

def namespace(directory):
    directory=Path(directory).resolve(strict=True)
    if not directory.is_relative_to(ROOT/'test/results/search-managed-parameter'):raise ValueError('owned_results_directory_required')
    options=private_json(directory/'managed-options.json')
    capacity=options.get('mode')=='capacity-software'and options.get('test_profile')=='capacity-50k'and bool(re.fullmatch(r'ainvr-tests/search-managed-capacity50k-[a-zA-Z0-9_-]{1,60}',options.get('relative_path','')))
    hardware=options.get('mode')=='managed-hardware'and 'test_profile'not in options
    if not(capacity or hardware)or options.get('volume_id')!=VOLUME or not re.fullmatch(r'ainvr-tests/search-managed-[a-zA-Z0-9_-]{1,80}',options.get('relative_path','')):raise ValueError('explicit_hardware_storage_required')
    matches=[v for v in storage.inventory()['volumes']if v['id']==VOLUME and v['selectable']and not v['system']and not v['readOnly']and v['state']=='mounted']
    if len(matches)!=1:raise ValueError('authorized_volume_unavailable')
    volume=matches[0];mount=Path(volume['mountPath'])
    fd=os.open(mount,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        s=os.fstat(fd)
        if s.st_dev==os.stat('/').st_dev:raise ValueError('no_emmc_fallback')
    finally:os.close(fd)
    return directory,options,mount,mount/options['relative_path']

def scan(fd,device,uid,depth=0,max_bytes=MAX_BYTES):
    if depth>2:raise ValueError('fixture_depth_exceeded')
    result=[];count=0;size=0
    with os.scandir(fd)as entries:
        for entry in entries:
            s=os.stat(entry.name,dir_fd=fd,follow_symlinks=False)
            if s.st_dev!=device or s.st_uid!=uid or stat.S_ISLNK(s.st_mode):raise ValueError('fixture_identity_changed')
            count+=1
            if count>MAX_FILES:raise ValueError('fixture_file_quota')
            if stat.S_ISDIR(s.st_mode):
                child=os.open(entry.name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
                try:children,n,bytes_=scan(child,device,uid,depth+1,max_bytes)
                finally:os.close(child)
                count+=n;size+=bytes_;result.append((entry.name,s,children))
            elif stat.S_ISREG(s.st_mode)and s.st_nlink==1:
                size+=s.st_size;result.append((entry.name,s,None))
            else:raise ValueError('unexpected_fixture_object')
            if count>MAX_FILES or size>max_bytes:raise ValueError('fixture_byte_or_file_quota')
    return result,count,size

def remove_entries(fd,entries):
    for name,expected,children in entries:
        current=os.stat(name,dir_fd=fd,follow_symlinks=False)
        if(current.st_dev,current.st_ino,current.st_uid,current.st_mode)!=(expected.st_dev,expected.st_ino,expected.st_uid,expected.st_mode):raise ValueError('fixture_changed_before_remove')
        if children is not None:
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            try:remove_entries(child,children)
            finally:os.close(child)
            os.rmdir(name,dir_fd=fd)
        else:os.unlink(name,dir_fd=fd)

def usage(entries):
    logical=physical=0
    for _,info,children in entries:
        physical+=info.st_blocks*512
        if children is None:logical+=info.st_size
        else:
            child_logical,child_physical=usage(children)
            logical+=child_logical;physical+=child_physical
    return logical,physical

def capacity_usage(entries):
    result={}
    for name,info,children in entries:
        if name not in('mongo','index')or children is None:raise ValueError('capacity_profile_layout')
        logical,physical=usage(children)
        maximum=CAPACITY_MONGO_BYTES if name=='mongo'else CAPACITY_INDEX_BYTES
        result[name]={'logical_bytes':logical,'physical_bytes':physical+info.st_blocks*512,'max_bytes':maximum}
        if logical>maximum or result[name]['physical_bytes']>maximum:raise ValueError('capacity_profile_quota')
    return result

def main():
    if len(sys.argv)!=3 or sys.argv[1]not in('prepare','check','remove'):raise ValueError('explicit_storage_action_required')
    action=sys.argv[1];directory,options,mount,target=namespace(sys.argv[2]);guard_path=directory/'ssd-guard.json'
    capacity=options.get('test_profile')=='capacity-50k'
    maximum=CAPACITY_MONGO_BYTES+CAPACITY_INDEX_BYTES if capacity else MAX_BYTES
    if action=='prepare':
        parent=mount/'ainvr-tests'
        if not parent.exists():parent.mkdir(mode=0o700)
        p=parent.lstat()
        if not stat.S_ISDIR(p.st_mode)or parent.is_symlink()or p.st_uid!=os.geteuid()or p.st_mode&0o022 or p.st_dev!=mount.stat().st_dev:raise ValueError('test_parent_not_owned')
        if target.exists()or target.is_symlink()or guard_path.exists():raise ValueError('new_test_namespace_required')
        target.mkdir(mode=0o700);s=target.stat()
        with guard_path.open('x')as f:json.dump({'volume_id':VOLUME,'path':str(target),'device':s.st_dev,'inode':s.st_ino,'uid':s.st_uid},f)
        guard_path.chmod(0o600);print(json.dumps({'prepared':True,'max_files':MAX_FILES,'max_bytes':maximum,'test_profile':options.get('test_profile')}));return
    guard=private_json(guard_path)
    if guard.get('volume_id')!=VOLUME or guard.get('path')!=str(target):raise ValueError('owned_test_guard_mismatch')
    fd=os.open(target,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        s=os.fstat(fd)
        if(s.st_dev,s.st_ino,s.st_uid)!=(guard['device'],guard['inode'],guard['uid'])or s.st_mode&0o777!=0o700:raise ValueError('owned_test_root_changed')
        entries,count,bytes_=scan(fd,s.st_dev,s.st_uid,max_bytes=maximum)
        physical=usage(entries)[1]
        profile_usage=capacity_usage(entries)if capacity else None
        if action=='remove':
            # Caller must stop its Native writer first. All identities and the
            # entire bounded tree are verified BEFORE deleting any child.
            remove_entries(fd,entries)
    finally:os.close(fd)
    if action=='remove':target.rmdir();guard_path.unlink()
    print(json.dumps({'checked':True,'removed':action=='remove','files':count,'bytes':bytes_,'physical_bytes':physical,'max_bytes':maximum,'profile_usage':profile_usage}))
if __name__=='__main__':
    try:main()
    except Exception:
        print('owned_search_fixture_storage_refused',file=sys.stderr);raise SystemExit(1)
