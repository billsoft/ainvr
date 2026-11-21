import {cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, expect, it, vi} from 'vitest';
import {ptzService} from '@/api/ptzService';
import {PtzPanel} from '@/components/player/PtzPanel';

afterEach(()=>{cleanup();vi.restoreAllMocks();});
it('keeps the panel open on an unconfirmed Stop and retries the original lease on close',async()=>{
  const close=vi.fn();
  vi.spyOn(ptzService,'inspect').mockResolvedValue({supported:true,identity:'binding',source:{id:'cam',name:'camera'},
    capabilities:{panTilt:true,zoom:false,presets:false,presetWrite:false,position:true,moveStatus:true}});
  vi.spyOn(ptzService,'acquire').mockResolvedValue({sessionId:'mine',identity:'binding',leaseMs:1200});
  const command=vi.spyOn(ptzService,'command').mockResolvedValue({});
  const stop=vi.spyOn(ptzService,'stop').mockResolvedValueOnce({stopConfirmed:false}).mockResolvedValue({stopConfirmed:true});
  render(<PtzPanel channelId="cam" onClose={close}/>);
  const right=await screen.findByRole('button',{name:'向右'});
  fireEvent.keyDown(right,{key:'ArrowRight'});
  await waitFor(()=>expect(command).toHaveBeenCalled());
  const dismiss=screen.getByRole('button',{name:'关闭云台控制'});
  fireEvent.click(dismiss);
  await screen.findByText(/再次关闭可重试停转/);
  expect(close).not.toHaveBeenCalled();
  fireEvent.click(dismiss);
  await waitFor(()=>expect(close).toHaveBeenCalledOnce());
  expect(stop.mock.calls).toEqual([['cam','mine'],['cam','mine']]);
});
