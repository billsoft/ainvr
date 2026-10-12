// SRS WebRTC candidate IP 原地写入 —— 让 rtcCandidateIp 从"存了但没用的死配置"
// 变成真正生效的热更新字段。
//
// 背景（2026-09-04 排查记录）：srs.conf 原来以单文件 bind mount 挂进 SRS
// 容器，容器内对它做任何"临时文件 + rename 覆盖"式的原子写都会失败于
// "Device or resource busy"（rename 不能跨越 bind mount 的挂载点）——
// entrypoint 里那行 sed -i 因此从未真正生效过，WebRTC 此前能用纯粹是 SRS
// 自己原生解析 srs.conf 里 `$CANDIDATE` 这个环境变量占位符，跟 sed 逻辑无关。
//
// 修复：docker-compose.yml 把整个目录（./deploy/srs-conf）挂进容器，
// srs.conf 变成目录里的普通文件，原地写就能真正生效。更关键的是 SRS 容器
// 本身已经因为 SRS_IN_DOCKER=on 开着 auto_reload_for_docker（inotify 监视
// 这个目录），写完文件后 SRS 会自己感知变化并触发内部 reload（实测日志：
// `inotify event ... name=srs.conf, reload=1` → `reload config, signo=1`），
// **不需要重启容器**，且已验证运行中的 RTMP 推流/播放全程不受影响。
//
// 2026-10-08 改为默认自动：空值写 `candidate *;`，配合 srs.conf 里固定的
// `use_auto_detect_network_ip off; api_as_candidates on;`，SRS 把浏览器访问
// 本机用的地址（nginx 透传的 Host）作为候选地址——哪块网卡、什么 IP 访问都
// 自动正确，客户改 IP 不用动。填了地址则是在访问地址之外**额外**宣告该地址
// （用主机名/域名访问、端口映射时需要）。均已在 SRS 7.0.162 实测，含热重载。
// 不再有 `$CANDIDATE` 环境变量占位符：入口脚本启动时覆盖配置会冲掉页面保存的值。

import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

// ⚠️ 必须锚定行首（`^` + `m` 多行模式，允许前导空白，用捕获组保留缩进）——
// 不能写成裸的 /candidate\s+[^;]*;/：那样会匹配到文件里任何位置出现过
// "candidate" 字样的**注释行**（哪怕前面有 `# `），把解释性注释整行替换掉，
// 而且因为字符类 `[^;]` 会跨行匹配，一旦最先命中的是注释行、且注释里没有
// 分号，正则会一路吃到后面真正指令行的分号为止，反而把真正要改的那行也
// 吞掉却写不出预期内容。这个 bug 在 srs-entrypoint.sh 的 sed 里同样存在
// （逐行版本，表现是"注释行被单独吃掉"），2026-09-04 排查记录见该脚本注释。
const CANDIDATE_LINE_RE = /^([ \t]*)candidate[ \t]+[^;]*;/m;

function confPath(): string {
  return process.env.SRS_CONF_PATH || '/srs-conf/srs.conf';
}

/**
 * 把 candidate 值写进 srs.conf（原地、原子替换，触发 SRS 自身 auto-reload）。
 *
 * ip 为空字符串时写 `candidate *;`（自动：按浏览器访问地址）。
 *
 * 失败时抛异常，调用方决定如何反馈给 API 调用者——这里不吞异常，因为
 * "存进 console 设置但 SRS 侧没真的生效"必须让用户知道，不能装作成功。
 *
 * ⚠️ 加锁（与 jsonStore.ts 用同一个 proper-lockfile 库）：两个浏览器标签
 * 前后脚提交 candidate 改动时，此前会在同一个固定的 `${file}.tmp` 临时
 * 文件名上互相踩踏——一方的写入可能被另一方覆盖丢失（审计发现：本仓库
 * 另一处"原子写"实现 jsonStore.ts 一直有锁保护，唯独这里没有，严谨度
 * 不一致）。函数因此从同步改成异步，调用方需要 await。
 */
export async function writeCandidateIp(ip: string): Promise<void> {
  const file = confPath();
  const release = await lockfile.lock(file, { stale: 5000, retries: 3, realpath: false });
  try {
    const raw = fs.readFileSync(file, 'utf8');

    if (!CANDIDATE_LINE_RE.test(raw)) {
      throw new Error(`流媒体服务配置文件中没有找到 candidate 配置行，拒绝写入`);
    }

    const next = raw.replace(CANDIDATE_LINE_RE, (_match, indent: string) =>
      `${indent}candidate       ${ip || '*'};`,
    );
    if (next === raw) {
      return; // 值没变化，不必写盘（避免无意义触发 SRS reload）
    }

    // 原子写：tmp → fsync → rename（现在是目录挂载，rename 不再撞 EBUSY）
    const tmpFile = file + '.tmp';
    const fd = fs.openSync(tmpFile, 'w');
    try {
      fs.writeSync(fd, next, 0, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpFile, file);

    // fsync 目录，确保 rename 的元数据也落盘（同 jsonStore.ts 的做法）
    try {
      const dirFd = fs.openSync(path.dirname(file), 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // 目录 fsync 非关键，失败忽略
    }
  } finally {
    await release().catch(() => {
      // 释放失败不抛（锁会因 stale 自动过期），与 jsonStore.ts 的做法一致
    });
  }
}
