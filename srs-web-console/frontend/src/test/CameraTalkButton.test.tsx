import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,expect,it,vi} from 'vitest'
import {CameraTalkButton} from '@/components/player/CameraTalkButton'
import {request} from '@/api/httpClient'
vi.mock('@/api/httpClient', () => ({request:vi.fn()}))
afterEach(() => {cleanup();vi.unstubAllGlobals();vi.clearAllMocks()})

it('opens only on demand, meters real samples, sends audio, and releases the microphone',async()=>{
  const stop=vi.fn()
  const track={stop,onended:null}
  const getUserMedia=vi.fn(async()=>({getAudioTracks:()=>[track],getTracks:()=>[track]}))
  vi.stubGlobal('isSecureContext',true)
  vi.stubGlobal('navigator',Object.assign(Object.create(navigator),{mediaDevices:{getUserMedia}}))
  vi.stubGlobal('AudioContext',class{state='running'; resume=vi.fn(async()=>{}); close=vi.fn(async()=>{})
    audioWorklet={addModule:vi.fn(async()=>{})};createMediaStreamSource(){return {connect:vi.fn()}}})
  const port={onmessage:null as null|((event:{data:{pcm:ArrayBuffer;rms:number}})=>void)}
  vi.stubGlobal('AudioWorkletNode',class{port=port; disconnect=vi.fn()})
  vi.mocked(request).mockResolvedValue({session:'test'})
  render(<CameraTalkButton channel="input"/>)
  expect(getUserMedia).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button',{name:'开启麦克风喊话'}))
  await waitFor(()=>expect(request).toHaveBeenCalledWith('/talkback/channels/input',expect.anything()))
  const sample=new ArrayBuffer(3200)
  await act(async()=>port.onmessage?.({data:{pcm:sample,rms:0.25}}))
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('6')
  expect(screen.getByRole('status').textContent).toBe('正在喊话')
  await act(async()=>port.onmessage?.({data:{pcm:sample,rms:0}}))
  expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('0')
  fireEvent.click(screen.getByRole('button',{name:'关闭麦克风喊话'}))
  expect(stop).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledWith('/talkback/test',expect.objectContaining({method:'DELETE'}))
  expect(screen.queryByRole('meter')).toBeNull()
})

it('explains HTTP microphone restrictions without reserving a loudspeaker',()=>{
  vi.stubGlobal('isSecureContext',false)
  render(<CameraTalkButton channel="input"/>)
  fireEvent.click(screen.getByRole('button',{name:'开启麦克风喊话'}))
  expect(screen.getByRole('status').textContent).toContain('HTTPS')
  expect(request).not.toHaveBeenCalled()
})
