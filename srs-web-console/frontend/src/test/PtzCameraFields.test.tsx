import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { afterEach, it, expect, vi } from 'vitest';
import { PtzCameraFields } from '@/pages/Channels/PtzCameraFields';
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/api/httpClient', () => ({ request: api.request }));
afterEach(cleanup);
const base = { enabled: true, panTilt: null, zoom: null, presets: null };
it('ONVIF defaults to discovery and preserves existing preferences until edited', async () => {
  api.request.mockResolvedValue({ items: [{ key: 'onvif:d/s', revision: 4, settings: base }] });
  const draft = vi.fn();
  render(
    <PtzCameraFields
      sources={[{ protocol: 'onvif', deviceId: 'd', videoSource: 's' }]}
      onDraft={draft}
      onBusy={vi.fn()}
    />,
  );
  await waitFor(() => expect(screen.getByLabelText('镜头变焦能力')).not.toBeDisabled());
  expect(draft).toHaveBeenLastCalledWith({});
  expect(screen.queryByRole('option', { name: '已确认支持' })).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('镜头变焦能力'), { target: { value: 'false' } });
  expect(draft).toHaveBeenLastCalledWith({
    'onvif:d/s': { expectedRevision: 4, settings: { ...base, zoom: false } },
  });
});
it('GB batch edits carry an independent revision for each camera', async () => {
  api.request.mockResolvedValue({
    items: [
      { key: 'gb28181:d/a', revision: 1, settings: base },
      { key: 'gb28181:d/b', revision: 7, settings: { ...base, zoom: false } },
    ],
  });
  const draft = vi.fn();
  render(
    <PtzCameraFields
      sources={[
        { protocol: 'gb28181', deviceId: 'd', channelId: 'a' },
        { protocol: 'gb28181', deviceId: 'd', channelId: 'b' },
      ]}
      onDraft={draft}
      onBusy={vi.fn()}
    />,
  );
  await waitFor(() => expect(screen.getByLabelText('镜头变焦能力')).not.toBeDisabled());
  expect(screen.getByText(/所选画面配置不同/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('镜头变焦能力'), { target: { value: 'true' } });
  expect(draft).toHaveBeenLastCalledWith({
    'gb28181:d/a': { expectedRevision: 1, settings: { ...base, zoom: true } },
    'gb28181:d/b': { expectedRevision: 7, settings: { ...base, zoom: true } },
  });
});
