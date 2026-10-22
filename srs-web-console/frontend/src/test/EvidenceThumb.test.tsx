import {render,act,waitFor,screen,fireEvent} from '@testing-library/react'
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
// One thumbnail per compact list row; offscreen evidence stays unloaded.
it('loads a stage thumbnail only once it scrolls into view',async()=>{
  const view=render(<EvidenceThumb eventId={'a'.repeat(64)} label="穿过"/>)
  expect(request).not.toHaveBeenCalled()
  await act(async()=>{observers[0]!.cb([{isIntersecting:true,target:observers[0]!.el!} as IntersectionObserverEntry],{} as IntersectionObserver)})
  expect(request).toHaveBeenCalledOnce()
  await waitFor(()=>expect(view.container.querySelector('img')).toHaveAttribute('src','blob:x'))
})
it('does not nest an interactive thumbnail inside a stage selection button',()=>{
 const view=render(<button type="button"><EvidenceThumb compact eventId={'b'.repeat(64)} label="接近"/></button>)
 expect(view.container.querySelector('button button')).toBeNull()
 expect(screen.queryByRole('button',{name:/放大/})).not.toBeInTheDocument()
})
it('a thumbnail with an open action remains keyboard accessible',()=>{
 const open=vi.fn();render(<EvidenceThumb compact eventId={'c'.repeat(64)} label="穿过" onOpen={open}/>)
 fireEvent.click(screen.getByRole('button',{name:/穿过.*截图/}))
 expect(open).toHaveBeenCalledOnce()
})
it('does not display the previous alarm image while loading a different event',async()=>{
 const view=render(<EvidenceThumb eventId={'a'.repeat(64)} label="出现"/>)
 await act(async()=>{observers[0]!.cb([{isIntersecting:true,target:observers[0]!.el!} as IntersectionObserverEntry],{} as IntersectionObserver)})
 await waitFor(()=>expect(view.container.querySelector('img')).toBeInTheDocument())
 vi.mocked(request).mockImplementation(()=>new Promise(()=>{}))
 view.rerender(<EvidenceThumb eventId={'b'.repeat(64)} label="接近"/>)
 expect(view.container.querySelector('img')).toBeNull()
})
