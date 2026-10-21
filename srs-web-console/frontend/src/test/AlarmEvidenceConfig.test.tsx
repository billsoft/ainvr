import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {AlarmServiceConfigForm} from '@/pages/ConfigCenter/AlarmServiceConfigForm'
it('saves independent evidence policy in the central service config and blocks an invalid quota',async()=>{
 const save=vi.fn().mockResolvedValue(undefined),document={config:{port:8200,database:'ainvr_alarm',mongo_uri:'${secret:alarm-service/mongo_uri}',api_token:'${secret:alarm-service/api_token}',producer_token:'${secret:alarm-service/producer_token}'}} as never
 render(<AlarmServiceConfigForm document={document} onSaveBatch={save}/>)
 fireEvent.click(screen.getByLabelText('独立保存新告警的原帧目标截图'))
 fireEvent.change(screen.getByLabelText('截图容量上限（GiB）'),{target:{value:'0.01'}})
 fireEvent.click(screen.getByRole('button',{name:'保存并应用'}));expect(await screen.findByRole('alert')).toHaveTextContent('至少 0.125 GiB');expect(save).not.toHaveBeenCalled()
 fireEvent.change(screen.getByLabelText('截图容量上限（GiB）'),{target:{value:'1'}});fireEvent.change(screen.getByLabelText('截图保留天数'),{target:{value:'7'}})
 fireEvent.click(screen.getByRole('button',{name:'保存并应用'}));await waitFor(()=>expect(save).toHaveBeenCalledOnce())
 expect(save.mock.calls[0]![0][0].config.evidence).toEqual({enabled:true,retention_days:7,max_bytes:1024**3})
 expect(screen.getByText(/关闭后停止保存新截图/)).toBeInTheDocument()
})
