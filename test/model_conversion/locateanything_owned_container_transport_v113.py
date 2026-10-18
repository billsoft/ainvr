"""Task-only WSL transport to the existing official compilation container.

Docker API currently stalls. No daemon restart, new container or quota changes.
Move only this newly spawned shell into the existing task's v1 resource groups
before entering its namespaces/root/environment. The invisible name=systemd
hierarchy is not a resource controller; every mounted resource controller and
the unified hierarchy must match. Never move an existing process.
"""
import shlex,subprocess
CID='117cf5eec42ec23b0aba1fa3c438a825cf05bdd5be05a14ee841a1dc31a9cef9'
PREFIX=r'''set -eu
cid=117cf5eec42ec23b0aba1fa3c438a825cf05bdd5be05a14ee841a1dc31a9cef9
test "$(awk '{print $22}' /proc/2277/stat)" = 8459
test "$(cat /sys/fs/cgroup/cpu/docker/$cid/cpu.cfs_quota_us)" = 800000
test "$(cat /sys/fs/cgroup/cpu/docker/$cid/cpu.cfs_period_us)" = 100000
test "$(cat /sys/fs/cgroup/memory/docker/$cid/memory.limit_in_bytes)" = 27917287424
test "$(cat /sys/fs/cgroup/freezer/docker/$cid/freezer.state)" = THAWED
test -d /proc/2277/root/work/official-llm-v1
for controller in cpuset cpu cpuacct blkio memory devices freezer net_cls perf_event net_prio hugetlb pids rdma misc; do
 test -w /sys/fs/cgroup/$controller/docker/$cid/cgroup.procs
done
test -w /sys/fs/cgroup/unified/docker/$cid/cgroup.procs
for controller in cpuset cpu cpuacct blkio memory devices freezer net_cls perf_event net_prio hugetlb pids rdma misc; do
 echo $$ > /sys/fs/cgroup/$controller/docker/$cid/cgroup.procs
done
echo $$ > /sys/fs/cgroup/unified/docker/$cid/cgroup.procs
test "$(awk -F: '$2=="cpu" {print $3}' /proc/$$/cgroup)" = /docker/$cid
test "$(awk -F: '$2=="memory" {print $3}' /proc/$$/cgroup)" = /docker/$cid
exec nsenter --target=2277 --mount --uts --ipc --net --pid --cgroup --root --wdns=/work/official-llm-v1 --env '''
def script(args):return (PREFIX+shlex.join([str(x) for x in args])+'\n').encode()
def run(args,timeout=30):
 return subprocess.run(['wsl','-d','docker-desktop','-u','root','--','sh'],input=script(args),capture_output=True,timeout=timeout)
def start(args,stdout,stderr):
 p=subprocess.Popen(['wsl','-d','docker-desktop','-u','root','--','sh'],stdin=subprocess.PIPE,stdout=stdout,stderr=stderr)
 p.stdin.write(script(args));p.stdin.close();return p
