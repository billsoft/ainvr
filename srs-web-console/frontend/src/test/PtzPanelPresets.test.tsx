import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PtzPanel } from '@/components/player/PtzPanel';
import type { PtzPreset } from '@/api/ptzService';

const api = vi.hoisted(() => ({
  inspect: vi.fn(), presets: vi.fn(), save: vi.fn(), remove: vi.fn(), updatePreset: vi.fn(),
  acquire: vi.fn(), stop: vi.fn(), goto: vi.fn(), command: vi.fn(),
}));
vi.mock('@/api/ptzService', () => ({ ptzService: api, ptzError: (e: Error) => e.message }));
const http = vi.hoisted(() => vi.fn());
vi.mock('@/api/httpClient', () => ({request: http}));
it('updates the encoded native id with PUT using only name and shortcut', async () => {
  const {ptzService} = await vi.importActual<typeof import('@/api/ptzService')>('@/api/ptzService');
  await ptzService.updatePreset('cam/1','preset/2',{name:'入口',shortcut:null});
  expect(http).toHaveBeenCalledExactlyOnceWith('/channels/cam%2F1/ptz/presets/preset%2F2',
    expect.objectContaining({method:'PUT',body:JSON.stringify({name:'入口',shortcut:null})}));
});
let items: PtzPreset[];
beforeEach(() => {
  vi.resetAllMocks();
  items = Array.from({length: 7}, (_, i) => ({id: String(i+1), name: '位置' + (i+1)}));
  items[0]!.shortcut = 1;
  api.inspect.mockResolvedValue({enabled: true, supported: true, identity: 'fake',
    capabilities: {presets: true, presetWrite: true}});
  api.presets.mockImplementation(async () => ({items: [...items], supported: true}));
  api.stop.mockResolvedValue({stopConfirmed: true});
  api.acquire.mockResolvedValue({sessionId: 'fake-lease', leaseMs: 1500});
  api.command.mockResolvedValue({motionFinished:true});
  api.save.mockImplementation(async (_channel, draft) => {
    const id = draft.id || '15';
    items = [...items.filter(p => p.id !== id), {...draft, id}];
    return {id};
  });
  api.updatePreset.mockImplementation(async (_channel, id, draft) => ({...draft, id}));
  api.remove.mockImplementation(async (_channel, id) => {
    items = items.filter(p => p.id !== id);
  });
});
afterEach(cleanup);
const btn = (name: string) => screen.getByRole('button', {name});
const edit = () => fireEvent.click(btn('管理预置点'));
const nameField = () => screen.getByLabelText('预置点名称');
function select(id: string) {
  fireEvent.change(screen.getByLabelText('保存到预置点'), {target: {value: id}});
}
async function open() {
  render(<PtzPanel channelId="fake-camera" onClose={() => {}} />);
  await screen.findByRole('button', {name:/位置1/});
}
it('clears the old filter and reveals the native id on its page after creation; only an explicit call moves', async () => {
  await open();
  fireEvent.change(screen.getByLabelText('查找预置点'), {target: {value:'位置2'}});
  edit();
  fireEvent.change(nameField(), {target: {value:' 重名点 '}});
  fireEvent.click(btn('保存当前位置'));
  const saved = await screen.findByRole('button', {name:'重名点'});
  expect(saved).toHaveAttribute('aria-current','true');
  expect(screen.queryByLabelText('预置点名称')).toBeNull();
  expect(screen.getByLabelText('查找预置点')).toHaveValue('');
  expect(api.save).toHaveBeenCalledWith('fake-camera', {name:'重名点', shortcut:null});
  expect(api.acquire).not.toHaveBeenCalled();
  fireEvent.click(saved);
  await waitFor(() => expect(api.goto).toHaveBeenCalledWith('fake-camera','15','fake-lease',1));
});
it('retains the name and shortcut after a failed save, and returning to the list discards the draft', async () => {
  await open(); edit();
  api.save.mockRejectedValueOnce(Error('保存失败'));
  fireEvent.change(nameField(), {target:{value:'入口'}});
  const shortcuts = screen.getByLabelText('预置点快捷编号');
  expect(within(shortcuts).getByRole('option',{name:'1'})).toBeDisabled();
  fireEvent.change(shortcuts, {target:{value:'2'}});
  fireEvent.click(btn('保存当前位置'));
  await screen.findByText('保存失败');
  expect(nameField()).toHaveValue('入口');
  expect(shortcuts).toHaveValue('2');
  fireEvent.click(btn('返回列表')); edit();
  expect(nameField()).toHaveValue('');
  expect(api.goto).not.toHaveBeenCalled();
});
it('edits metadata with PUT alone, preserves a rejected draft and reveals the updated id', async () => {
  await open(); edit(); select('2');
  fireEvent.change(nameField(), {target:{value:'新入口'}});
  fireEvent.change(screen.getByLabelText('预置点快捷编号'), {target:{value:'4'}});
  expect(btn('覆盖为当前位置')).toBeDisabled();
  api.updatePreset.mockRejectedValueOnce(Error('快捷编号已被使用'));
  fireEvent.click(btn('保存名称和快捷编号'));
  await screen.findByText('快捷编号已被使用');
  expect(nameField()).toHaveValue('新入口');
  expect(screen.getByLabelText('保存到预置点')).toHaveValue('2');
  fireEvent.click(btn('保存名称和快捷编号'));
  expect(await screen.findByRole('button',{name:/新入口/})).toHaveAttribute('aria-current','true');
  expect(api.updatePreset).toHaveBeenCalledWith('fake-camera','2',{name:'新入口',shortcut:4});
  for (const command of [api.save, api.acquire, api.goto, api.stop]) expect(command).not.toHaveBeenCalled();
});
it('identifies the original overwrite target, supports cancel, and locates the saved position', async () => {
  await open(); edit(); select('2');
  fireEvent.click(btn('覆盖为当前位置'));
  const confirmation = screen.getByRole('group',{name:'核对预置点操作'});
  expect(confirmation).toHaveTextContent('位置2');
  expect(confirmation).toHaveTextContent('编号 2');
  fireEvent.click(btn('取消'));
  expect(api.save).not.toHaveBeenCalled();
  fireEvent.click(btn('覆盖为当前位置')); fireEvent.click(btn('确认覆盖'));
  expect(await screen.findByRole('button',{name:'位置2'})).toHaveAttribute('aria-current','true');
  expect(api.save).toHaveBeenCalledWith('fake-camera',{id:'2',name:'位置2',shortcut:null});
  expect(api.acquire).not.toHaveBeenCalled();
});
it('deletes only the confirmed native id and returns to the refreshed list', async () => {
  await open(); edit(); select('2');
  fireEvent.click(btn('删除此预置点')); fireEvent.click(btn('取消'));
  expect(api.remove).not.toHaveBeenCalled();
  fireEvent.click(btn('删除此预置点')); fireEvent.click(btn('确认删除'));
  await screen.findByRole('button',{name:'管理预置点'});
  await waitFor(() => expect(screen.queryByRole('button',{name:'位置2'})).toBeNull());
  expect(api.remove).toHaveBeenCalledExactlyOnceWith('fake-camera','2');
  expect(screen.getByRole('button',{name:/位置1/})).toBeEnabled();
  expect(api.goto).not.toHaveBeenCalled();
});

it('shows the controller timeout in manual mode and clears the saved notice when goto starts', async () => {
  await open(); edit();
  fireEvent.change(nameField(), {target: {value: '测试入口'}});
  fireEvent.click(btn('保存当前位置'));
  const saved = await screen.findByRole('button', {name: '测试入口'});
  expect(screen.getByText(/预置点已保存/)).toBeVisible();
  expect(btn('手动控制')).toHaveAttribute('aria-pressed', 'true');
  api.command.mockResolvedValue({motionFinished: false});
  vi.useFakeTimers();
  try {
    await act(async () => { fireEvent.click(saved); });
    expect(api.goto).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/预置点已保存/)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(screen.getByText(/已停止等待，设备未确认到位/)).toBeVisible();
  } finally {
    vi.useRealTimers();
  }
});
