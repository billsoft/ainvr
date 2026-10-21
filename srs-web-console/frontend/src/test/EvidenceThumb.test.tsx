import {render,act,waitFor} from '@testing-library/react'
import {it,expect,vi,beforeEach} from 'vitest'
import {EvidenceThumb} from '@/pages/AlarmCenter/EvidenceThumb'
import {request,requestBlob} from '@/api/httpClient'
vi.mock('@/api/httpClient',()=>({request:vi.fn(),requestBlob:vi.fn()}))
let observers:{cb:IntersectionObserverCallback;el?:Element}[]=[]
beforeEach(()=>{
  vi.clearAllMocks();observers=[]
  vi.stubGlobal('IntersectionObserver',class{cb:IntersectionObserverCallback;constructor(cb:IntersectionObserverCallback){this.cb=cb;observers.push({cb})}observe(el:Element){observers.at(-1)!.el=el}disconnect(){}unobserve(){}})
  vi.mocked(request).mockResolvedValue({state:'available',evidence:{variants:['processed']}})
  vi.mocked(requestBlob).mockResolvedValue(new Blob(['x']))
  vi.stubGlobal('URL',{...URL,createObjectURL:()=>'blob:x',revokeObjectURL:()=>{}})
})
// A page of 50 cards x 4 stages must not fire hundreds of requests at once.
it('loads a stage thumbnail only once it scrolls into view',async()=>{
  const view=render(<EvidenceThumb eventId={'a'.repeat(64)} label="穿过"/>)
  expect(request).not.toHaveBeenCalled()
  await act(async()=>{observers[0]!.cb([{isIntersecting:true,target:observers[0]!.el!} as IntersectionObserverEntry],{} as IntersectionObserver)})
  expect(request).toHaveBeenCalledOnce()
  await waitFor(()=>expect(view.container.querySelector('img')).toHaveAttribute('src','blob:x'))
})
