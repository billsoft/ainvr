import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PtzPanel } from '@/components/player/PtzPanel';

const mock = vi.hoisted(() => ({
  state: 'idle', notice: '', error: '', zoomStep: vi.fn(), inspect: vi.fn(), presets: vi.fn(), start: vi.fn(), stop: vi.fn(),
  refresh: vi.fn(), center: vi.fn(), begin: vi.fn(), stopConfirmed: vi.fn(),
  calibration: {running: false, progress: 0, total: 24, ready: 0, message: ''},
}));
vi.mock('@/api/ptzService', () => ({
  ptzService: { inspect: mock.inspect, presets: mock.presets }, ptzError: String,
}));
vi.mock('@/components/player/usePtzControl', () => ({
  usePtzControl: () => ({
    state: mock.state, notice: mock.notice, error: mock.error, zoomStep: mock.zoomStep, calibration: mock.calibration, calibrate: mock.start, stop: mock.stop,
    refreshCalibration: mock.refresh,
    centerPoint: mock.center, begin: mock.begin, stopConfirmed: mock.stopConfirmed,
    clearFeedback: vi.fn(), stopScreenGesture: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mock.state = 'idle';
  mock.notice = '';
  mock.error = '';
  mock.start.mockResolvedValue(undefined);
  mock.refresh.mockResolvedValue(undefined);
  Object.assign(mock.calibration, {running: false, progress: 0, total: 24, ready: 0, message: ''});
  mock.inspect.mockResolvedValue({supported:true, enabled:true, identity:'camera-id',
    capabilities:{panTilt:true, zoom:true, presets:true}});
  mock.presets.mockResolvedValue({items:[{id:'1', name:'门口', shortcut:1}]});
  mock.stopConfirmed.mockResolvedValue(true);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fixture(initiallyReady: boolean) {
  const host = document.body.appendChild(document.createElement('div'));
  const video = host.appendChild(document.createElement('video'));
  let ready = initiallyReady;
  Object.defineProperties(video, {
    videoWidth: {get: () => ready ? 1920 : 0}, videoHeight: {get: () => ready ? 1080 : 0},
    readyState: {get: () => ready ? 4 : 0}, paused: {value:false},
    clientWidth: {value:640}, clientHeight: {value:360},
  });
  return {host,video,play: () => { ready = true; fireEvent.loadedData(video); fireEvent.playing(video); }};
}
it('explains GB patrol on click without switching modes or issuing a motion command', async () => {
  mock.inspect.mockResolvedValue({supported:true, enabled:true, protocol:'gb28181', identity:'gb',
    capabilities:{panTilt:true, position:true}});
  const {host,video} = fixture(true);
  try {
    render(<PtzPanel channelId="gb" video={video} onClose={() => {}}/>);
    const hint = '水平巡航目前仅支持可回报云台位置的 ONVIF 通道。';
    const patrol = await screen.findByTitle(hint);
    fireEvent.click(patrol);
    expect(screen.getByText(hint)).toBeVisible();
    expect(screen.getByRole('button',{name:'手动控制'})).toHaveAttribute('aria-pressed','true');
    expect(screen.queryByRole('region',{name:'巡航设置'})).toBeNull();
    expect(mock.stopConfirmed).not.toHaveBeenCalled();
    expect(mock.begin).not.toHaveBeenCalled();
    fireEvent.blur(patrol);
    expect(screen.queryByText(hint)).toBeNull();
  } finally { host.remove(); }
});

async function enterAim() {
  const aim = screen.getByRole('button',{name:'点击居中'});
  await waitFor(() => expect(aim).toBeEnabled());
  fireEvent.click(aim);
  await waitFor(() => expect(aim).toHaveAttribute('aria-pressed','true'));
}

it('reads calibration once when video becomes ready and starts only on explicit request', async () => {
  const {host,video,play} = fixture(false);
  try {
    const panel = () => <PtzPanel channelId="camera" video={video} onClose={() => {}}/>;
    const view = render(panel());
    await screen.findByRole('button',{name:/门口/});
    expect(screen.queryByRole('region',{name:'点击居中标定'})).toBeNull();
    await enterAim();
    expect(screen.getByRole('region',{name:'点击居中标定'})).toBeVisible();
    expect(screen.queryByText('标定后定位 · 滚轮变焦')).toBeNull();
    const start = screen.getByRole('button',{name:'开始标定'});
    expect(start).toBeDisabled();
    expect(screen.getByText('等待视频就绪')).toBeVisible();
    expect(mock.refresh).not.toHaveBeenCalled();
    play(); view.rerender(panel());
    expect(mock.refresh).toHaveBeenCalledExactlyOnceWith(video);
    mock.calibration.message = '请先完成当前倍率标定';
    view.rerender(panel());
    expect(screen.getByText('已标定 0/4 方向')).toBeVisible();
    expect(start).toBeEnabled();
    expect(screen.queryByText('等待视频就绪')).toBeNull();
    expect(mock.start).not.toHaveBeenCalled();
    fireEvent.click(start);
    expect(mock.start).toHaveBeenCalledExactlyOnceWith(video);

    Object.assign(mock.calibration, {running:true, progress:3, ready:1, message:'待标定方向：左、上、下'});
    view.rerender(panel());
    expect(screen.getByText('标定中 3/24')).toHaveAttribute('title','待标定方向：左、上、下');
    expect(screen.queryByRole('button',{name:'选择要居中的画面位置'})).toBeNull();
    for (const name of ['拉近', '拉远', '手动控制', /门口/]) {
      expect(screen.getByRole('button',{name})).toBeDisabled();
    }
    fireEvent.keyDown(screen.getByRole('complementary'),{key:'1'});
    expect(mock.begin).not.toHaveBeenCalled();
    expect(screen.getByRole('button',{name:'停止云台转动'})).toBeEnabled();
    fireEvent.click(screen.getByRole('button',{name:'停止标定'}));
    expect(mock.stop).toHaveBeenCalledTimes(1);

    Object.assign(mock.calibration, {running:false, progress:8, ready:4, message:''});
    view.rerender(panel());
    expect(screen.getByText('已标定 · 滚轮变焦')).toBeVisible();
    expect(screen.queryByText(/标定中/)).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'重新标定'}));
    expect(mock.start).toHaveBeenCalledTimes(2);
    expect(mock.refresh).toHaveBeenCalledTimes(1);
  } finally { host.remove(); }
});

it('refreshes once at idle after a button or wheel zoom, and skips ordinary positioning pulses', async () => {
  const {host,video} = fixture(true);
  try {
    const panel = () => <PtzPanel channelId="camera" video={video} onClose={() => {}}/>;
    const view = render(panel());
    await enterAim();
    await waitFor(() => expect(mock.refresh).toHaveBeenCalledTimes(1));
    for (const source of ['button','wheel','point']) {
      mock.refresh.mockClear();
      if (source === 'button') fireEvent.click(screen.getByRole('button',{name:'拉近'}));
      if (source === 'wheel') fireEvent.wheel(screen.getByRole('button',{name:'选择要居中的画面位置'}),{deltaY:-10});
      mock.state = 'moving';
      view.rerender(panel());
      expect(mock.refresh).not.toHaveBeenCalled();
      mock.state = 'idle';
      view.rerender(panel());
      expect(mock.refresh).toHaveBeenCalledTimes(source === 'point' ? 0 : 1);
    }
    expect(mock.zoomStep).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button',{name:/门口/}));
    await waitFor(() => expect(mock.begin).toHaveBeenCalledTimes(1));
    await enterAim();
    await waitFor(() => expect(mock.refresh).toHaveBeenCalledExactlyOnceWith(video));
  } finally { host.remove(); }
});

it('leaves native click-to-center available without calibration', async () => {
  mock.inspect.mockResolvedValue({supported:true, enabled:true, identity:'native-id',
    capabilities:{panTilt:true, pointCenter:true}});
  const {host,video} = fixture(true);
  try {
    render(<PtzPanel channelId="native" video={video} onClose={() => {}}/>);
    await enterAim();
    expect(screen.getByRole('button',{name:'选择要居中的画面位置'})).toBeEnabled();
    expect(screen.queryByRole('region',{name:'点击居中标定'})).toBeNull();
    expect(mock.refresh).not.toHaveBeenCalled();
    expect(mock.start).not.toHaveBeenCalled();
  } finally { host.remove(); }
});

it('shows a shared calibration notice once and preserves distinct control feedback', async () => {
  const {host,video} = fixture(true);
  const success = '四方向标定完成，可点击画面定位';
  try {
    mock.calibration.message = success;
    mock.notice = success;
    const panel = () => <PtzPanel channelId="camera" video={video} onClose={() => {}}/>;
    const view = render(panel());
    expect(screen.getByText(success)).toBeVisible();
    await enterAim();
    expect(screen.getByRole('region', {name:'点击居中标定'})).toContainElement(screen.getByText(success));
    mock.notice = '视频反馈不足，未能确认点击位置是否已居中。';
    mock.error = '停止尚未确认';
    view.rerender(panel());
    expect(screen.getByText(mock.notice)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent(mock.error);
  } finally { host.remove(); }
});
