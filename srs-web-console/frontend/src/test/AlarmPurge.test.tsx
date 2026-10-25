import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {it,expect,vi,beforeEach} from 'vitest'
import {AlarmPurgeDialog} from '@/pages/AlarmCenter/AlarmPurgeDialog'
import {alarmEventService} from '@/api/alarmEventService'
vi.mock('@/api/alarmEventService',()=>({alarmEventService:{purge:vi.fn()}}))
beforeEach(()=>vi.mocked(alarmEventService.purge).mockReset())
it('clear all requires a password, cancels without mutation, and exposes an accessible close button',()=>{
 const close=vi.fn();render(<AlarmPurgeDialog close={close} cleared={vi.fn()}/>);
 expect(screen.getByRole('dialog',{name:'清空所有告警'})).toBeInTheDocument();expect(screen.getByRole('button',{name:'验证密码并清空所有告警'})).toBeDisabled();expect(screen.getByLabelText('系统密码')).toHaveAttribute('type','password');
 fireEvent.click(screen.getByRole('button',{name:'关闭'}));expect(close).toHaveBeenCalled();expect(alarmEventService.purge).not.toHaveBeenCalled();
})
it('clear failure wipes password and retry reuses the operation key; success reports the server count',async()=>{
 vi.mocked(alarmEventService.purge).mockRejectedValueOnce(Error('系统密码不正确')).mockResolvedValueOnce({cleared:true,deleted_count:1082,cutoff:'2026-10-25T10:00:00Z'});
 const cleared=vi.fn();render(<AlarmPurgeDialog close={vi.fn()} cleared={cleared}/>);
 fireEvent.change(screen.getByLabelText('系统密码'),{target:{value:'wrong'}});fireEvent.click(screen.getByRole('button',{name:'验证密码并清空所有告警'}));
 expect(await screen.findByRole('alert')).toHaveTextContent('系统密码不正确');expect(screen.getByLabelText('系统密码')).toHaveValue('');expect(cleared).not.toHaveBeenCalled();
 fireEvent.change(screen.getByLabelText('系统密码'),{target:{value:'correct'}});fireEvent.click(screen.getByRole('button',{name:'验证密码并清空所有告警'}));
 await waitFor(()=>expect(cleared).toHaveBeenCalledWith(1082));expect(vi.mocked(alarmEventService.purge).mock.calls[0]![1]).toBe(vi.mocked(alarmEventService.purge).mock.calls[1]![1]);
})
