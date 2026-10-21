import {it,expect,vi} from 'vitest'
import {createZoneSaveSession,type AlarmZoneInput,type ZoneSaveResult} from '@/api/alarmZoneService'
const zone:AlarmZoneInput={zone_id:'z1',channel_id:'gate',name:'门',geometry_revision:'g1',points:[[0,0],[1,0],[1,1]],state:'active'}
const result=(z:AlarmZoneInput,v:number):ZoneSaveResult=>({zone:{...z,version:v+1},saved:true,monitoring_enabled:false})
it('a lost reply replays the same payload, version and operation key without duplicate creation',async()=>{
  const send=vi.fn().mockRejectedValueOnce(Error('lost reply')).mockImplementation(async(z,v)=>result(z,v))
  const session=createZoneSaveSession(0,send)
  await expect(session.save(zone)).rejects.toThrow('lost reply')
  expect((await session.save(zone)).zone.version).toBe(1)
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
});
it('edits after a timeout settle the old write before saving the new revision',async()=>{
  const send=vi.fn().mockRejectedValueOnce(Error('timeout')).mockImplementation(async(z,v)=>result(z,v))
  const session=createZoneSaveSession(0,send)
  await expect(session.save(zone)).rejects.toThrow()
  expect((await session.save({...zone,name:'新区域'})).zone.version).toBe(2)
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
  expect(send.mock.calls[2]![0].name).toBe('新区域')
  expect(send.mock.calls[2]![1]).toBe(1)
  expect(send.mock.calls[2]![2]).not.toBe(send.mock.calls[0]![2])
});
it('version conflicts never silently overwrite the latest version',async()=>{
  const send=vi.fn().mockRejectedValue(Object.assign(Error('changed'),{code:'version_conflict'}))
  const session=createZoneSaveSession(3,send)
  await expect(session.save(zone)).rejects.toThrow()
  await expect(session.save({...zone,name:'changed'})).rejects.toThrow()
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0])
});
