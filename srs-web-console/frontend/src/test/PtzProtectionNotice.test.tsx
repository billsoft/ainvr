import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { PtzProtectionNotice } from '@/components/PtzProtectionNotice';
const call = vi.hoisted(() => vi.fn());
vi.mock('@/api/httpClient', () => ({ request: call }));
beforeEach(() => {
  vi.clearAllMocks();
  call.mockResolvedValue({
    items: [
      {
        source: { id: 'input', name: '入口摄像头' },
        channels: [{ id: 'output', name: '入口 AI' }],
        blocked: true,
        stopPending: false,
        reason: 'external_motion',
      },
    ],
  });
});
afterEach(cleanup);
it('shows persistent protection and the original-camera recovery entry outside the PTZ panel', async () => {
  render(<PtzProtectionNotice />);
  expect(await screen.findByText(/检测到外部视角变化/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '核对视角并恢复' })).toHaveAttribute(
    'href',
    '/monitor?ptz=input',
  );
});
it('matches AI outputs and keeps arming drafts in place without a navigation link', async () => {
  render(<PtzProtectionNotice sourceId="output" allowNavigation={false} />);
  expect(await screen.findByText(/请保存布防后/)).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
it('does not show unrelated-camera protection inside another source editor', async () => {
  render(<PtzProtectionNotice sourceId="other" />);
  await waitFor(() => expect(call).toHaveBeenCalled());
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
