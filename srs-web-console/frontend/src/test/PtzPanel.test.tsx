import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { PtzPanel } from '@/components/player/PtzPanel';
const api = vi.hoisted(() => ({
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
  api.goto.mockResolvedValue({});
});
afterEach(cleanup);
it('names the actual camera, shows presets and closes through Esc', async () => {
  const close = vi.fn();
  render(<PtzPanel channelId="ai-output" onClose={close} />);
  expect(await screen.findByText('原始后门摄像头')).toBeInTheDocument();
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
  await screen.findByText('原始后门摄像头');
  const input = screen.getByLabelText('预置点名称');
  fireEvent.keyDown(input, { key: 'ArrowLeft' });
  fireEvent.keyDown(screen.getByLabelText('云台速度'), { key: 'ArrowRight' });
  expect(api.acquire).not.toHaveBeenCalled();
});

it('overwriting a native preset requires confirmation and does not move the camera', async () => {
  render(<PtzPanel channelId="camera" onClose={() => {}} />);
  await screen.findByRole('button', { name: /前门/ });
  fireEvent.change(screen.getByLabelText('保存到预置点'), { target: { value: 'one' } });
  fireEvent.click(screen.getByRole('button', { name: '覆盖为当前位置' }));
  expect(api.save).not.toHaveBeenCalled();
  expect(await screen.findByRole('dialog', { name: '覆盖预置点' })).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('confirm-ok'));
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
  expect(screen.getByRole('button', { name: '停止摄像头' })).not.toBeDisabled();
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
  fireEvent.click(screen.getByRole('button', { name: '紧急停止摄像头' }));
  await waitFor(() => expect(api.stop).toHaveBeenCalledWith('camera', null));
  finish({ sessionId: 'late-lease', leaseMs: 1200 });
  await waitFor(() => expect(api.stop).toHaveBeenCalledWith('camera', 'late-lease'));
  expect(api.command).not.toHaveBeenCalled();
});
it('system modifier shortcuts never move the camera', async () => {
  render(<PtzPanel channelId="camera" onClose={() => {}} />);
  await screen.findByText('原始后门摄像头');
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
