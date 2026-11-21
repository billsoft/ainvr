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
it('shows the reason for suspension when editing the affected source', async () => {
  render(<PtzProtectionNotice sourceId="input" />);
  expect(await screen.findByText(/检测到外部视角变化/)).toBeInTheDocument();
  expect(screen.getByText(/入口摄像头/)).toBeVisible();
});
it('matches AI outputs and keeps arming drafts in place without a navigation link', async () => {
  render(<PtzProtectionNotice sourceId="output" />);
  expect(await screen.findByText(/视频下方的「布防待核对」/)).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});
it('does not show unrelated-camera protection inside another source editor', async () => {
  render(<PtzProtectionNotice sourceId="other" />);
  await waitFor(() => expect(call).toHaveBeenCalled());
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});
it.each(['external_motion','camera_control'])('distinguishes matched scene bindings without clearing %s protection',async reason=>{
 call.mockResolvedValue({items:[{source:{id:'input',name:'入口摄像头'},channels:[],blocked:true,stopPending:true,reason}]});
 render(<PtzProtectionNotice sourceId="input"/>);
 const notice=await screen.findByRole('status',{name:'摄像头视角保护提示'});
 expect(notice).toHaveTextContent('未绑定或未匹配区域的关联告警与计数仍暂停');
 expect(notice).toHaveTextContent('已匹配的绑定区域按场景核验状态恢复');
 expect(notice).toHaveTextContent('停止尚未确认');
 expect(notice).not.toHaveTextContent('已暂停关联告警与计数');
 expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
