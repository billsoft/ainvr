import { describe, it, expect, vi } from 'vitest';
import { restoreLocalConfig } from '../store/restoreLocalConfig.js';
function setup(desiredVersion: number | null = null) {
  const store = { getServiceState: vi.fn(async () => ({desiredVersion})),
    getLatestVersion: vi.fn(async () => ({version: 10})),
    getVersionSnapshotForService: vi.fn(async () => [{service:'backend'}]),
    updateServiceState: vi.fn(async () => ({})) };
  const adapter = {serviceName:'backend', validate:vi.fn(async()=>({ok:true,errors:[]})),
    apply:vi.fn(async()=>({ok:true,applyVia:'hot',restartRequired:false}))};
  return {store,adapter,run:()=>restoreLocalConfig(store as any,adapter as any)};
}
describe('startup configuration acknowledgement',()=>{
  it('repairs initial unknown only after successful application',async()=>{
    const x=setup(); expect(await x.run()).toBe(true);
    expect(x.adapter.apply).toHaveBeenCalled();
    expect(x.store.updateServiceState).toHaveBeenCalledWith(expect.objectContaining({desiredVersion:10,appliedVersion:10,status:'applied',errorMessage:''}));
  });
  it('restores service desired snapshot, not unrelated latest release',async()=>{
    const x=setup(3); await x.run();
    expect(x.store.getLatestVersion).not.toHaveBeenCalled();
    expect(x.store.getVersionSnapshotForService).toHaveBeenCalledWith(3,'backend');
  });
  it('does not turn apply failures into success',async()=>{
    const x=setup(3); x.adapter.apply.mockRejectedValue(new Error('secret'));
    expect(await x.run()).toBe(false);
    expect(x.store.updateServiceState).toHaveBeenCalledWith(expect.objectContaining({status:'failed'}));
    expect(JSON.stringify(x.store.updateServiceState.mock.calls)).not.toContain('secret');
  });
  it('keeps restart requirements visible',async()=>{
    const x=setup(3); x.adapter.apply.mockResolvedValue({ok:true,applyVia:'hot',restartRequired:true});
    await x.run(); expect(x.store.updateServiceState).toHaveBeenCalledWith(expect.objectContaining({status:'partial',restartRequired:true}));
  });
  it('missing snapshot is a failure, not a false acknowledgement',async()=>{
    const x=setup(3); x.store.getVersionSnapshotForService.mockResolvedValue([]);
    expect(await x.run()).toBe(false); expect(x.adapter.apply).not.toHaveBeenCalled();
  });
});

it('never invents a version for an unpublished service',async()=>{
  const x=setup(); x.store.getVersionSnapshotForService.mockResolvedValue([]);
  expect(await x.run()).toBe(true); expect(x.adapter.apply).not.toHaveBeenCalled();
  expect(x.store.updateServiceState).toHaveBeenCalledWith(expect.objectContaining({status:'unknown',errorMessage:''}));
  expect(x.store.updateServiceState.mock.calls[0][0]).not.toHaveProperty('appliedVersion');
});
