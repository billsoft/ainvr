import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import type { AiDetection } from '@/types/aiChannel';
import { PtzPanel } from '@/components/player/PtzPanel';
const api = vi.hoisted(() => ({
  followSession: vi.fn(),
  followStep: vi.fn(),
  lens: vi.fn(),
  restore: vi.fn(),
  center: vi.fn(),
  inspect: vi.fn(),
  presets: vi.fn(),
  stop: vi.fn(),
  acquire: vi.fn(),
  command: vi.fn(),
  goto: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
}));
vi.mock('@/api/ptzService', () => ({ ptzService: api, ptzError: (e: Error) => e.message }));
vi.mock('@/store/toast', () => ({ toast: { error: vi.fn() } }));
beforeEach(() => {
  vi.clearAllMocks();
  api.inspect.mockResolvedValue({
    supported: true,
    enabled: true,
    source: { id: 'source', name: '原始后门摄像头' },
    identity: 'hash',
    protocol: 'onvif',
    capabilities: { panTilt: true, zoom: true, presets: true, presetWrite: true },
  });
  api.presets.mockResolvedValue({
    items: [
      { id: 'one', name: '前门', shortcut: 1 },
      { id: 'two', name: '后门', shortcut: 2 },
    ],
  });
  api.stop.mockResolvedValue({ stopConfirmed: true });
  api.acquire.mockResolvedValue({ sessionId: 'lease', leaseMs: 1200 });
  api.command.mockResolvedValue({});
  api.followSession.mockResolvedValue({sessionId:'follow-lease'});
  api.followStep.mockResolvedValue({choices:[]});
  api.goto.mockResolvedValue({});
});
afterEach(cleanup);
it('keeps aim enabled across moves and scopes wheel zoom to the visible video', async () => {
  api.inspect.mockResolvedValue({ supported: true, enabled: true, identity: 'hash',
    capabilities: { pointCenter: true, zoom: true } });
  api.command.mockResolvedValue({ motionFinished: true });
  const host = document.createElement('div');
  const video = host.appendChild(document.createElement('video'));
  Object.defineProperties(video, {
    clientWidth: { value: 800 }, clientHeight: { value: 600 },
    videoWidth: { value: 1920 }, videoHeight: { value: 1080 }, readyState: { value: 4 },
  });
  document.body.append(host);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  try {
    render(<PtzPanel channelId="camera" video={video} onClose={() => {}} />);
    const toggle = await screen.findByRole('button', { name: '点击居中' });
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    const area = await screen.findByRole('button', { name: '选择要居中的画面位置' });
    expect(area.style.height).toBe('450px');
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 75, 800, 450));
    const click = () => fireEvent.click(area, { clientX: 600, clientY: 300, detail: 1 });
    click();
    click();
    await waitFor(() => expect(api.stop).toHaveBeenCalledTimes(1));
    await screen.findByText('点画面任意位置居中 · 滚轮变焦');
    expect(screen.getByRole('button', {name:'拉近'})).toBeEnabled();
    expect(screen.getByRole('button', {name:'拉远'})).toBeEnabled();
    expect(api.center).toHaveBeenCalledExactlyOnceWith('camera', 'lease', 1, .5, 0);
    click();
    await waitFor(() => expect(api.stop).toHaveBeenCalledTimes(2));
    await screen.findByText('点画面任意位置居中 · 滚轮变焦');
    expect(screen.getByRole('button', { name: '手动控制' })).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(fireEvent.wheel(host, { deltaY: -100, cancelable: true })).toBe(true);
    expect(fireEvent.wheel(area, { deltaY: -100, cancelable: true })).toBe(false);
    await waitFor(() => expect(api.command).toHaveBeenCalledWith('camera', 'lease', 1, { zoom: .35, pan: 0, tilt: 0 }, false));
    fireEvent.click(screen.getByRole('button', { name: '手动控制' }));
    await waitFor(() => expect(api.stop).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(area).not.toBeInTheDocument());
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
  } finally {
    cleanup();
    host.remove();
    vi.unstubAllGlobals();
  }
});
it('names the actual camera, shows presets and closes through Esc', async () => {
  const close = vi.fn();
  render(<PtzPanel channelId="ai-output" onClose={close} />);
  expect(await screen.findByRole('button', { name: /前门/ })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('complementary'), { key: 'Escape' });
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1));
});
it('a zoom-only camera has zoom buttons but no direction pad', async () => {
  api.inspect.mockResolvedValue({
    supported: true,
    source: { id: 'source', name: '固定镜头' },
    identity: 'hash',
    capabilities: { panTilt: false, zoom: true, presets: false },
  });
  render(<PtzPanel channelId="camera" onClose={() => {}} />);
  expect(await screen.findByRole('button', { name: '拉近' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '向左' })).not.toBeInTheDocument();
});
it('typing and editing speed never sends camera movement', async () => {
  render(<PtzPanel channelId="camera" onClose={() => {}} />);
  fireEvent.click(await screen.findByRole('button', {name:'管理预置点'}));
  const input = screen.getByLabelText('预置点名称');
  fireEvent.keyDown(input, { key: 'ArrowLeft' });
  fireEvent.keyDown(screen.getByLabelText('云台速度'), { key: 'ArrowRight' });
  expect(api.acquire).not.toHaveBeenCalled();
});

it('overwriting a native preset requires confirmation and does not move the camera', async () => {
  render(<PtzPanel channelId="camera" onClose={() => {}} />);
  await screen.findByRole('button', { name: /前门/ });
  fireEvent.click(await screen.findByRole('button', {name:'管理预置点'}));
  fireEvent.change(screen.getByLabelText('保存到预置点'), { target: { value: 'one' } });
  fireEvent.click(screen.getByRole('button', { name: '覆盖为当前位置' }));
  expect(api.save).not.toHaveBeenCalled();
  expect(await screen.findByRole('group', { name: '核对预置点操作' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'确认覆盖'}));
  await waitFor(() =>
    expect(api.save).toHaveBeenCalledWith('camera', { id: 'one', name: '前门', shortcut: 1 }),
  );
  expect(api.acquire).not.toHaveBeenCalled();
});
it('a camera being controlled elsewhere cannot accept a direction gesture', async () => {
  api.inspect.mockResolvedValue({
    supported: true,
    enabled: true,
    busy: true,
    source: { id: 'source', name: 'Shared camera' },
    identity: 'hash',
    capabilities: { panTilt: true, zoom: true, presets: false },
  });
  render(<PtzPanel channelId="camera" onClose={() => {}} />);
  expect(await screen.findByText('其他窗口正在控制')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '向左' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '停止' })).not.toBeDisabled();
});

it('priority Stop is sent while a slow acquisition is still pending', async () => {
  let finish!: (value: unknown) => void;
  api.acquire.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<PtzPanel channelId="camera" onClose={() => {}} />);
  const left = await screen.findByRole('button', { name: '向左' });
  fireEvent.pointerDown(left, { button: 0, pointerId: 1, isPrimary: true });
  await waitFor(() => expect(api.acquire).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: '停止' }));
  await waitFor(() => expect(api.stop).toHaveBeenCalledWith('camera', null));
  finish({ sessionId: 'late-lease', leaseMs: 1200 });
  await waitFor(() => expect(api.stop).toHaveBeenCalledWith('camera', 'late-lease'));
  expect(api.command).not.toHaveBeenCalled();
});
it('system modifier shortcuts never move the camera', async () => {
  render(<PtzPanel channelId="camera" onClose={() => {}} />);
  fireEvent.keyDown(screen.getByRole('complementary'), { key: 'ArrowLeft', ctrlKey: true });
  fireEvent.keyDown(screen.getByRole('complementary'), { key: '1', metaKey: true });
  expect(api.acquire).not.toHaveBeenCalled();
});

it.each(['ptz_timeout_unverified', 'ptz_spaces_unsupported', 'gb_capability_confirmation_required'])(
  'explains capability restrictions: %s', async (reason) => {
    api.inspect.mockResolvedValue({ supported: false, source: { name: 'Camera' }, capabilities: { reason } });
    render(<PtzPanel channelId="camera" onClose={() => {}} />);
    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(api.acquire).not.toHaveBeenCalled();
  },
);

it('finds the last of 300 positions without issuing a move', async () => {
  api.presets.mockResolvedValue({items: Array.from({length:300}, (_,i) => ({id:String(i+1),name:'位置 '+(i+1)}))});
  render(<PtzPanel channelId="camera" onClose={() => {}}/>);
  fireEvent.change(await screen.findByLabelText('查找预置点'),{target:{value:'300'}});
  expect(screen.getByRole('button',{name:/位置 300/})).toBeEnabled();
  expect(api.goto).not.toHaveBeenCalled();
});
it('routes lens adjustments to the selected camera', async () => {
  api.inspect.mockResolvedValue({ supported:true, enabled:true, identity:'hash', capabilities:{focus:true,autoFocus:true} });
  render(<PtzPanel channelId="camera" onClose={() => {}}/>);
  expect(api.lens).not.toHaveBeenCalled();
  fireEvent.click(await screen.findByRole('button',{name:'恢复自动对焦'}));
  await waitFor(() => expect(api.lens).toHaveBeenCalledWith('camera','auto'));
});

it('visits assigned shortcuts in order after confirmed idle',async()=>{
  api.inspect.mockResolvedValue({supported:true,enabled:true,identity:'hash',
    capabilities:{presets:true,moveStatus:true}});
  api.presets.mockResolvedValue({items:[
    {id:'door',name:'门口',shortcut:2},{id:'unused',name:'设备位置'},{id:'desk',name:'柜台',shortcut:1}
  ]});
  api.command.mockResolvedValue({motionFinished:true});
  render(<PtzPanel channelId="camera" onClose={()=>{}}/>);
  const start=await screen.findByRole('button',{name:'按快捷编号巡看一次'});
  await waitFor(()=>expect(start).toBeEnabled());fireEvent.click(start);
  await waitFor(()=>expect(api.goto.mock.calls.map(call=>call[1])).toEqual(['desk','door']),{timeout:6000});
  expect(await screen.findByText('本次巡看完成')).toBeInTheDocument();
},8500);

it('opens guard below the player and only restores after an explicit choice', async () => {
  api.inspect.mockResolvedValue({supported:true, enabled:true, identity:'hash', guard:{blocked:true, baseline:true, revision:3}});
  const {rerender} = render(<PtzPanel channelId="camera" onClose={() => {}}/>);
  await screen.findByText('按住转动，松开停止');
  expect(screen.queryByText('布防待核对')).not.toBeInTheDocument();
  const armingHost=document.createElement("div"); document.body.append(armingHost);
  rerender(<PtzPanel channelId="camera" armingHost={armingHost} isAiOutput onClose={() => {}}/>);
  fireEvent.click(await screen.findByText('布防待核对'));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(api.restore).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button',{name:'已回原视角，恢复'}));
  await waitFor(() => expect(api.restore).toHaveBeenCalledWith('camera',3,'position'));
});

it('keeps the same mode selector and presets on a raw camera, with AI tracking unavailable', async () => {
  render(<PtzPanel channelId="camera" onClose={() => {}} />);
  expect(await screen.findByRole('button', {name:/前门/})).toBeEnabled();
  expect(screen.getByRole('button', {name:'手动控制'})).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', {name:'点击居中'})).toBeDisabled();
  expect(screen.getByRole('button', {name:'AI 跟踪'})).toBeDisabled();
});

it('picks targets on the AI video while keeping the shared preset list in place', async () => {
  const video = document.createElement('video');
  const picking = vi.fn();
  const observed = { track_id:'test-session:1', class_name:'chair', bbox:{x:40,y:40,w:20,h:20} } as AiDetection;
  api.followStep.mockResolvedValue({choices:[{id:observed.track_id}]});
  render(<PtzPanel channelId="ai" isAiOutput video={video} followProcessor="processor"
    displayedTracks={{current:() => [observed]}} onTrackPickingChange={picking} onClose={() => {}} />);
  const preset = await screen.findByRole('button', {name:/前门/});
  const follow = screen.getByRole('button', {name:'AI 跟踪'});
  expect(screen.getByRole('button', {name:'点击居中'})).toBeEnabled();
  fireEvent.click(follow);
  await waitFor(() => expect(follow).toHaveAttribute('aria-pressed', 'true'));
  await waitFor(() => expect(picking).toHaveBeenCalledWith(expect.objectContaining({onPick:expect.any(Function)})));
  expect(screen.queryByRole('button', {name:'向左'})).not.toBeInTheDocument();
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  expect(screen.getByRole('button', {name:'拉近'})).toBeEnabled();
  expect(screen.getByRole('button', {name:'拉远'})).toBeEnabled();
  expect(preset).toBeEnabled();
  fireEvent.keyDown(screen.getByRole('complementary'), {key:'ArrowLeft'});
  expect(api.acquire).not.toHaveBeenCalled();
  fireEvent.click(preset);
  await waitFor(() => expect(api.goto).toHaveBeenCalledWith('ai','one','lease',1));
  expect(screen.getByRole('button', {name:'手动控制'})).toHaveAttribute('aria-pressed','true');
  expect(picking).toHaveBeenLastCalledWith(null);
});

it('stops an operator zoom without leaving click-to-center mode', async () => {
  const video = document.createElement('video');
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  try {
    render(<PtzPanel channelId="camera" video={video} onClose={() => {}} />);
    const aim = screen.getByRole('button', {name:'点击居中'});
    await waitFor(() => expect(aim).toBeEnabled());
    fireEvent.click(aim);
    await waitFor(() => expect(aim).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(await screen.findByRole('button', {name:'拉近'}));
    await waitFor(() => expect(api.command).toHaveBeenCalledWith('camera','lease',1,{pan:0,tilt:0,zoom:.35},false));
    fireEvent.click(screen.getByRole('button', {name:'停止云台转动'}));
    await waitFor(() => expect(api.stop).toHaveBeenCalledWith('camera',null));
    expect(aim).toHaveAttribute('aria-pressed','true');
  } finally { cleanup(); vi.unstubAllGlobals(); }
});

it('clears a point positioning error when the operator selects AI tracking', async () => {
  const host = document.createElement('div');
  const video = host.appendChild(document.createElement('video'));
  Object.defineProperties(video, {
    clientWidth: {value:640}, clientHeight: {value:480},
    videoWidth: {value:640}, videoHeight: {value:480}, readyState: {value:4},
  });
  document.body.append(host);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  api.inspect.mockResolvedValue({supported:true, enabled:true, identity:'hash', capabilities:{pointCenter:true,panTilt:true}});
  api.center.mockRejectedValueOnce(Error('定位已停止'));
  try {
    render(<PtzPanel channelId="ai" video={video} isAiOutput followProcessor="p" onTrackPickingChange={() => {}} onClose={() => {}} />);
    const aim = screen.getByRole('button', {name:'点击居中'});
    await waitFor(() => expect(aim).toBeEnabled());
    fireEvent.click(aim);
    const surface = await screen.findByRole('button', {name:'选择要居中的画面位置'});
    vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue(new DOMRect(0,0,640,480));
    fireEvent.click(surface, {clientX:460,clientY:250,detail:1});
    expect(await screen.findByRole('alert')).toHaveTextContent('定位已停止');
    const follow = screen.getByRole('button', {name:'AI 跟踪'});
    fireEvent.click(follow);
    await waitFor(() => expect(follow).toHaveAttribute('aria-pressed','true'));
    expect(screen.queryByText('定位已停止')).not.toBeInTheDocument();
  } finally { cleanup(); host.remove(); vi.unstubAllGlobals(); }
});
