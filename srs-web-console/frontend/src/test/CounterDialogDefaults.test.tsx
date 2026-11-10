import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import {CounterDialog} from '@/pages/Flow/CounterDialog'

// Measured on recorded traffic: 1.5 s keeps 2-3 FPS channels counting through
// short misses and changes nothing at full frame rate; 2 s starts double counts.
it('a new counter keeps short misses for 1.5 s by default',async()=>{
 const send=vi.fn().mockImplementation(async(input,version)=>({saved:true,counter:{...input,version:version+1}}))
 render(<CounterDialog labels={[{label_id:'person',name:'person'}]} onCancel={vi.fn()} onSaved={vi.fn()} send={send}/>)
 expect(screen.getByLabelText('短时漏检保留（秒）')).toHaveValue(1.5)
 fireEvent.change(screen.getByLabelText('名称'),{target:{value:'客流'}})
 fireEvent.click(screen.getByRole('button',{name:/保存/}))
 await waitFor(()=>expect(send).toHaveBeenCalled())
 expect(send).toHaveBeenCalledWith(expect.objectContaining({max_gap_ms:1500}),0,expect.any(String))
})
