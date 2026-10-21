import {it,expect} from 'vitest';
import {AlarmConfigAdapter,alarmSettingsSchema} from '../store/alarmConfigAdapter.js';
import {KNOWN_SECRET_PATHS} from '../routes/configPolicy.js';
const config={host:'127.0.0.1',port:8200,database:'ainvr_alarm',mongo_uri:'${secret:alarm-service/mongo_uri}',api_token:'${secret:alarm-service/api_token}',producer_token:'${secret:alarm-service/producer_token}'};
it('alarm service validates its own secrets and cannot report a pull configuration applied prematurely',async()=>{
  expect(alarmSettingsSchema.safeParse(config).success).toBe(true);
  for(const patch of [{host:'0.0.0.0'},{database:'admin'},{port:80},{api_token:'${secret:ai-service/api_token}'},{producer_token:config.api_token},{extra:true}])expect(alarmSettingsSchema.safeParse({...config,...patch}).success).toBe(false);
  const adapter=new AlarmConfigAdapter();
  expect(await adapter.validate([{group:'system',name:'settings',config} as never])).toEqual({ok:true,errors:[]});
  expect((await adapter.validate([])).ok).toBe(false);
  expect(await adapter.apply([],3)).toMatchObject({applyVia:'pull'});
  expect(KNOWN_SECRET_PATHS['alarm-service']).toEqual([['mongo_uri'],['api_token'],['producer_token']]);
});

it('evidence retention policy is centrally validated without allowing arbitrary filesystem roots',()=>{
 const evidence={enabled:true,retention_days:30,max_bytes:2*1024**3};
 expect(alarmSettingsSchema.safeParse({...config,evidence}).success).toBe(true);
 for(const patch of [{retention_days:0},{max_bytes:1},{max_bytes:1024**5},{root:'/tmp/foreign'}])expect(alarmSettingsSchema.safeParse({...config,evidence:{...evidence,...patch}}).success).toBe(false);
});
