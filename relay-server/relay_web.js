'use strict';
// 远程协助中转管理页面。所有数据经 textContent 渲染，不拼接 HTML。
(() => {
  const $ = (id) => document.getElementById(id);
  let csrf = null, status = null, setupMode = false, filter = 'all', tab = 'devices', timer = null;

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return node;
  }

  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
    let data = {};
    try { data = await res.json(); } catch (_) { /* 非 JSON 响应 */ }
    if (res.status === 401 && !path.startsWith('/api/login') && !path.startsWith('/api/setup')) { showGate(); throw new Error(data.error || '请先登录'); }
    if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
    return data;
  }

  function toast(text, bad = false) {
    const t = $('toast'); t.textContent = text; t.className = bad ? 'toast bad' : 'toast'; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 4000);
  }

  // ---------------------------------------------------------- 登录 / 初始化
  async function boot() {
    try {
      const s = await api('GET', '/api/session');
      if (s.authenticated) { csrf = s.csrf; showApp(); } else { setupMode = s.setup_required; showGate(); }
    } catch (e) { setupMode = false; showGate(); $('gate-error').textContent = e.message; }
  }

  function showGate() {
    stopRefresh(); csrf = null; $('app').hidden = true; $('gate').hidden = false;
    $('code-row').hidden = !setupMode; $('confirm-row').hidden = !setupMode;
    $('gate-submit').textContent = setupMode ? '设置密码并进入' : '登录';
    $('gate-hint').textContent = setupMode
      ? '首次使用：请输入服务器上的初始化码（在服务器执行 sudo cat /var/lib/ainvr-relay-web/setup.code 查看），并设置管理员密码（至少 10 个字符）。'
      : '请输入管理员密码。忘记密码可在服务器执行 sudo relayctl web-reset 重新初始化。';
    $('gate-password').autocomplete = setupMode ? 'new-password' : 'current-password';
    $('gate-password').focus();
  }

  $('gate-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = $('gate-error'); err.textContent = '';
    const password = $('gate-password').value;
    try {
      let r;
      if (setupMode) {
        if (password.length < 10) throw new Error('密码至少 10 个字符');
        if (password !== $('gate-confirm').value) throw new Error('两次输入的密码不一致');
        r = await api('POST', '/api/setup', { code: $('gate-code').value.trim(), password });
      } else {
        r = await api('POST', '/api/login', { password });
      }
      csrf = r.csrf; $('gate-password').value = ''; $('gate-confirm').value = ''; $('gate-code').value = '';
      showApp();
    } catch (e) { err.textContent = e.message; }
  });

  function showApp() { $('gate').hidden = true; $('app').hidden = false; refresh(); startRefresh(); }
  function startRefresh() { stopRefresh(); timer = setInterval(() => { if (!document.hidden) refresh(); }, 5000); }
  function stopRefresh() { if (timer) clearInterval(timer); timer = null; }

  // ---------------------------------------------------------- 数据
  async function refresh() {
    try {
      status = await api('GET', '/api/status');
      $('error-banner').hidden = true;
      $('refreshed').textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
      render();
      if (tab === 'audit') loadAudit();
    } catch (e) {
      if (!$('app').hidden) { $('error-banner').textContent = `读取状态失败：${e.message}。可在服务器上使用 sudo relayctl list。`; $('error-banner').hidden = false; }
    }
  }

  const fmtBytes = (n) => { n = Number(n) || 0; if (n < 1024) return `${n} B`; if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`; if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`; return `${(n / 1073741824).toFixed(2)} GB`; };
  const fmtEpoch = (s) => s ? new Date(s * 1000).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
  const pill = (cls, text, dot = true) => el('span', { class: `pill ${cls}` }, dot ? el('span', { class: 'dot' }) : null, text);
  const deviceName = (d) => d.label ? `${d.label}（${d.grouped}）` : d.grouped;
  const isSuspended = (d) => d.suspended || status.global_suspended;

  function render() {
    const s = status;
    const svc = (name, v) => pill(v === 'active' ? 'ok' : 'bad', `${name}${v === 'active' ? '正常' : '异常'}`);
    $('chips').replaceChildren(...[svc('中转服务', s.services.relay), svc('鉴权插件', s.services.auth),
      s.dashboard_ok ? null : pill('warn', '在线状态暂不可读'), s.identities_ok ? null : pill('bad', '设备身份表不可读')].filter(Boolean));
    $('global-banner').hidden = !s.global_suspended;
    $('global-text').textContent = `已全部暂停：所有设备的远程协助连接被拒绝${s.global_reason ? '（原因：' + s.global_reason + '）' : ''}。单台暂停另行保留。`;
    $('btn-global-suspend').hidden = s.global_suspended;
    renderWork();
    const online = s.devices.filter((d) => d.online).length;
    const card = (label, value) => el('div', { class: 'card' }, el('div', { class: 'label', text: label }), el('div', { class: 'value', text: String(value) }));
    $('cards').replaceChildren(card('在线设备', online), card('出现过的设备', s.devices.length),
      card('已暂停', s.devices.filter(isSuspended).length), card('身份冲突', s.devices.filter((d) => d.conflict).length));
    renderDevices(); renderConnections();
  }

  function renderWork() {
    const w = status.work;
    $('work-banner').hidden = !w.device;
    if (!w.device) return;
    const d = status.devices.find((x) => x.device === w.device);
    $('work-text').replaceChildren(el('div', {}, el('strong', { text: '当前工作设备：' }), d ? deviceName(d) : w.grouped, ' ',
      w.state === 'active' ? pill('ok', '入口已就绪', false) : pill('bad', '入口未运行', false),
      d && !d.online ? pill('warn', '设备不在线', false) : null),
      el('div', { class: 'small', text: '在公司电脑执行下面的命令登录（先输入云服务器密码，再输入设备密码）：' }),
      el('div', { class: 'cmd mono', text: w.command }));
  }

  function renderDevices() {
    const q = $('search').value.trim().toLowerCase().replace(/-/g, '');
    const rows = status.devices.filter((d) => {
      if (q && !d.device.toLowerCase().includes(q) && !(d.label || '').toLowerCase().includes(q)) return false;
      if (filter === 'online') return d.online;
      if (filter === 'offline') return !d.online;
      if (filter === 'suspended') return isSuspended(d);
      if (filter === 'conflict') return d.conflict;
      return true;
    });
    $('devices-empty').hidden = status.devices.length > 0;
    $('devices-body').replaceChildren(...rows.map((d) => {
      const cloud = d.conflict ? el('div', {}, pill('bad', '身份冲突'), el('div', { class: 'small muted', text: `${d.conflict.ip} · ${fmtEpoch(d.conflict.ts)} 被拒` }))
        : isSuspended(d) ? el('div', {}, pill('bad', d.suspended ? '已暂停' : '全部暂停中'), d.reason ? el('div', { class: 'small muted', text: d.reason }) : null)
          : pill('ok', '允许');
      const onlineCell = d.online === null ? pill('', '未知')
        : d.online ? el('div', {}, pill('ok', '在线'), el('div', { class: 'small muted', text: `${d.client_ip || ''} · ${d.hostname || ''}` }))
          : el('div', {}, pill('', '离线', false), d.last_close ? el('div', { class: 'small muted', text: `${d.last_close} 下线` }) : null);
      const actions = [];
      if (d.work) actions.push(el('button', { class: 'small', text: '结束工作', onclick: () => setWork(null) }));
      else if (d.online && !isSuspended(d)) actions.push(el('button', { class: 'small primary', text: '设为当前工作', onclick: () => setWork(d) }));
      actions.push(d.suspended ? el('button', { class: 'small', text: '重新允许', onclick: () => resumeDevice(d) })
        : el('button', { class: 'small', text: '暂停（踢下线）', onclick: () => suspendDevice(d) }));
      actions.push(el('button', { class: 'small ghost', text: '更多', onclick: () => moreDevice(d) }));
      return el('tr', { class: d.work ? 'work-row' : '' },
        el('td', {}, el('div', { text: d.label || '未备注', class: d.label ? '' : 'muted' }), el('div', { class: 'mono', text: d.grouped }),
          d.work ? pill('ok', '当前工作', false) : null),
        el('td', {}, cloud), el('td', {}, onlineCell),
        el('td', {}, el('span', { text: String(d.conns || 0), class: d.conns ? '' : 'muted' })),
        el('td', { class: 'small' }, `↓${fmtBytes(d.traffic_in)} ↑${fmtBytes(d.traffic_out)}`),
        el('td', {}, el('div', { class: 'actions' }, ...actions)));
    }));
  }

  function renderConnections() {
    const byId = Object.fromEntries(status.devices.map((d) => [d.device, d]));
    $('conn-empty').hidden = status.connections.length > 0;
    $('conn-body').replaceChildren(...status.connections.map((c) => {
      const who = c.role === 'device' ? el('div', {}, pill('ok', '设备', false), ' ', byId[c.name] ? deviceName(byId[c.name]) : c.name)
        : c.role === 'relay' ? el('div', {}, pill('warn', '工作入口', false), ' → ', byId[c.name] ? deviceName(byId[c.name]) : c.name)
          : pill('', '未识别', false);
      const action = c.role === 'device' && byId[c.name] && !byId[c.name].suspended
        ? el('button', { class: 'small', text: '暂停（踢下线）', onclick: () => suspendDevice(byId[c.name]) }) : null;
      return el('tr', {}, el('td', {}, who), el('td', { class: 'mono', text: c.ip }), el('td', { text: c.hostname }),
        el('td', { text: fmtEpoch(c.connected_at) }), el('td', {}, el('div', { class: 'actions' }, action)));
    }));
  }

  const ACTION = { suspend: '暂停', 'suspend-hard': '强制断开', resume: '恢复', work: '设为当前工作', 'work-clear': '结束工作',
    reset: '重置设备身份', label: '修改备注', fleet: '统一接入凭据', 'web-reset': '重置网页密码' };
  async function loadAudit() {
    try {
      const rows = await api('GET', '/api/audit');
      $('audit-body').replaceChildren(...rows.map((a) => el('tr', {},
        el('td', { text: fmtEpoch(a.ts) }), el('td', { text: a.actor || '' }), el('td', { text: ACTION[a.action] || a.action }),
        el('td', { class: 'mono', text: a.target === '*' ? '全部设备' : a.target }), el('td', { text: a.reason || '' }))));
    } catch (e) { toast(e.message, true); }
  }

  // ---------------------------------------------------------- 弹窗
  function modal({ title, body, ok = '确定', danger = false, onOk, cancel = '取消' }) {
    $('modal-title').textContent = title;
    $('modal-body').replaceChildren(...[].concat(body).filter(Boolean));
    $('modal-error').textContent = '';
    const okBtn = $('modal-ok');
    okBtn.textContent = ok; okBtn.className = danger ? 'danger-btn' : 'primary'; okBtn.hidden = !onOk; okBtn.disabled = false;
    $('modal-cancel').textContent = onOk ? cancel : '关闭';
    $('modal').hidden = false;
    okBtn.onclick = async () => {
      okBtn.disabled = true; $('modal-error').textContent = '';
      try { await onOk(); } catch (e) { $('modal-error').textContent = e.message; } finally { okBtn.disabled = false; }
    };
    const first = $('modal-body').querySelector('input,select'); (first || okBtn).focus();
  }
  const closeModal = () => { $('modal').hidden = true; };
  $('modal-cancel').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });
  const field = (label, input) => el('label', {}, label, input);
  const note = (text, warn = false) => el('div', { class: warn ? 'note warn' : 'note', text });

  function download(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
    const a = el('a', { href: url, download: name }); document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function act(promise, done) {
    const r = await promise; closeModal(); toast(done || r.message || '已完成'); refresh(); return r;
  }

  function setWork(d) {
    const cur = status.work.device && status.devices.find((x) => x.device === status.work.device);
    modal({ title: d ? `设为当前工作 · ${deviceName(d)}` : '结束工作', ok: d ? '设为当前工作' : '结束工作',
      body: note(d
        ? `云服务器的固定入口将指向这台设备（${d.client_ip || ''} ${d.hostname || ''}）。${cur ? `原工作设备 ${deviceName(cur)} 上经入口建立的会话会断开，设备本身保持在线。` : ''}请先和客户核对页面上的机器码是否一致。`
        : '关闭固定入口，经入口建立的会话会断开；设备本身保持在线。'),
      onOk: () => act(api('POST', '/api/work', { device: d ? d.device : '' })) });
  }
  function suspendDevice(d) {
    const reason = el('input', { maxlength: '100', placeholder: '例如：客户长期占用 / 排查异常' });
    const hard = el('input', { type: 'checkbox' });
    modal({ title: `暂停 ${deviceName(d)}`, danger: true, ok: '暂停',
      body: [note('暂停后该设备在下一次心跳（约 10 秒内）断开，已建立的维护连接随之断开，新连接被拒绝。客户设备上的开关保持不变，恢复后自动重连。'),
        field('原因（写入操作记录）', reason),
        el('label', { class: 'check' }, hard, el('span', { text: '强制断开：立即断开该设备公网 IP 到中转服务器的连接（同一公网 IP 后的其他设备会被一并断开并几秒内自动重连）；无法按 IP 断开时会重启中转服务。只在设备不响应暂停时使用。' }))],
      onOk: () => act(api('POST', `/api/devices/${encodeURIComponent(d.device)}/suspend`, { reason: reason.value, hard: hard.checked })) });
  }
  function resumeDevice(d) {
    modal({ title: `重新允许 ${deviceName(d)}`, ok: '重新允许',
      body: note(`恢复后，只要客户设备上的远程协助仍开启，设备会在约 5–20 秒内自动重连。${status.global_suspended ? '注意：当前处于全部暂停，需同时解除全部暂停。' : ''}`),
      onOk: () => act(api('POST', `/api/devices/${encodeURIComponent(d.device)}/resume`)) });
  }
  function moreDevice(d) {
    const item = (text, fn, cls = '') => el('button', { class: cls, text, onclick: fn });
    modal({ title: deviceName(d), body: [el('div', { class: 'mono', text: d.grouped }),
      el('div', { class: 'small muted', text: `首次连上：${fmtEpoch(d.first_seen)}` }),
      el('div', { class: 'actions start' },
        item('修改备注', () => labelDevice(d)),
        item(d.conflict ? '重置设备身份（解决冲突）' : '重置设备身份', () => resetDevice(d), d.conflict ? 'primary' : 'danger-btn'),
        d.suspended ? null : item('强制断开', () => suspendDevice(d), 'danger-btn'))] });
  }
  function labelDevice(d) {
    const input = el('input', { maxlength: '40', value: d.label || '', placeholder: '客户名称、安装位置等' });
    modal({ title: `修改备注 · ${d.grouped}`, body: field('备注', input),
      onOk: () => act(api('POST', `/api/devices/${encodeURIComponent(d.device)}/label`, { label: input.value }), '备注已更新') });
  }
  function resetDevice(d) {
    modal({ title: `重置设备身份 · ${deviceName(d)}`, danger: true, ok: '重置',
      body: note(`中转服务器会忘记这个机器码原来记住的设备，下一台以该机器码连上来的设备将被重新记住。只在确认是客户重装系统或更换存储导致「身份冲突」时使用；${d.online ? '这台设备当前在线：如果在线的是真设备，冲突方可能是冒用者，请不要重置。' : ''}`, true),
      onOk: () => act(api('POST', `/api/devices/${encodeURIComponent(d.device)}/reset`)) });
  }
  function fleetMaterial() {
    modal({ title: '统一接入凭据', ok: '生成下载',
      body: [note('所有设备共用这份凭据，放到打包机 deploy-package/vendor/remote-assist/ 后随安装包写入设备，设备无需逐台开通。设备身份由设备首次连接时生成的本机令牌确立。'),
        note('文件含有密钥：只经受控渠道传递，不要发邮件或放进代码仓库。', true)],
      onOk: async () => {
        const r = await api('POST', '/api/fleet');
        closeModal();
        modal({ title: '下载统一接入凭据', body: el('div', { class: 'downloads' },
          ...Object.entries(r.material).map(([name, text]) => el('button', { class: 'primary', text: `下载 ${name}`, onclick: () => download(name, text) }))) });
      } });
  }
  function globalSuspend() {
    const reason = el('input', { maxlength: '100', placeholder: '例如：中转服务器维护 / 安全事件' });
    const hard = el('input', { type: 'checkbox' });
    modal({ title: '全部暂停', danger: true, ok: '全部暂停',
      body: [note('所有设备的远程协助连接将在下一次心跳（约 10 秒内）断开，并拒绝重新接入。客户设备上的开关不变；解除后自动重连。', true),
        field('原因（写入操作记录）', reason),
        el('label', { class: 'check' }, hard, el('span', { text: '强制断开：立即重启中转服务断开所有连接。' }))],
      onOk: () => act(api('POST', '/api/global/suspend', { reason: reason.value, hard: hard.checked })) });
  }
  function globalResume() {
    modal({ title: '解除全部暂停', ok: '解除',
      body: note('解除后，未被单独暂停且客户开关仍开启的设备会在约 5–20 秒内陆续自动重连（带随机延迟，不会同时冲击）。单独暂停的设备保持暂停。'),
      onOk: () => act(api('POST', '/api/global/resume')) });
  }
  function changePassword() {
    const old = el('input', { type: 'password', autocomplete: 'current-password' });
    const nw = el('input', { type: 'password', autocomplete: 'new-password' });
    const again = el('input', { type: 'password', autocomplete: 'new-password' });
    modal({ title: '修改管理员密码', ok: '修改',
      body: [field('当前密码', old), field('新密码（至少 10 个字符）', nw), field('再次输入新密码', again), note('修改后其他已登录的浏览器会被退出。')],
      onOk: async () => {
        if (nw.value.length < 10) throw new Error('新密码至少 10 个字符');
        if (nw.value !== again.value) throw new Error('两次输入的新密码不一致');
        const r = await api('POST', '/api/password', { old: old.value, new: nw.value });
        csrf = r.csrf; closeModal(); toast('密码已修改');
      } });
  }

  // ---------------------------------------------------------- 事件
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === b));
    for (const name of ['devices', 'connections', 'audit']) $(`tab-${name}`).hidden = name !== tab;
    if (tab === 'audit') loadAudit();
  }));
  document.querySelectorAll('#filters .chip-btn').forEach((b) => b.addEventListener('click', () => {
    filter = b.dataset.filter;
    document.querySelectorAll('#filters .chip-btn').forEach((x) => x.classList.toggle('active', x === b));
    if (status) renderDevices();
  }));
  $('search').addEventListener('input', () => { if (status) renderDevices(); });
  $('btn-fleet').addEventListener('click', fleetMaterial);
  $('btn-work-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(status.work.command); toast('已复制登录命令'); } catch (_) { toast('复制失败，请手动选中命令复制', true); }
  });
  $('btn-work-clear').addEventListener('click', () => setWork(null));
  $('btn-global-suspend').addEventListener('click', globalSuspend);
  $('btn-global-resume').addEventListener('click', globalResume);
  $('btn-password').addEventListener('click', changePassword);
  $('btn-logout').addEventListener('click', async () => { try { await api('POST', '/api/logout'); } catch (_) { /* 已失效 */ } setupMode = false; showGate(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && csrf) refresh(); });
  boot();
})();
