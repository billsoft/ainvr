import {it,expect,vi} from 'vitest';
import {AlarmCombinedSnapshot} from '../services/alarmCombinedSnapshot.js';
const snapshot=(revision:string,id:string)=>({schema_version:'1.0',revision,rules:[{id}]});
it('迁移期间单一发布者保留两套规则，不会清掉旧规则',async()=>{
 const source=new AlarmCombinedSnapshot({snapshot:async()=>snapshot('2','legacy')},{snapshot:async()=>snapshot('2','new')});
 expect(await source.snapshot()).toEqual({schema_version:'1.0',revision:'2',rules:[{id:'legacy'},{id:'new'}]});
});
it('并发修改时重新读取一致版本，不发布混合快照',async()=>{
 const legacy={snapshot:vi.fn().mockResolvedValueOnce(snapshot('1','old')).mockResolvedValue(snapshot('2','latest'))};
 const current={snapshot:async()=>snapshot('2','new')};
 expect((await new AlarmCombinedSnapshot(legacy,current).snapshot()).rules).toEqual([{id:'latest'},{id:'new'}]);
 const duplicate={snapshot:async()=>snapshot('2','same')};
 await expect(new AlarmCombinedSnapshot(duplicate,duplicate).snapshot()).rejects.toThrow('Duplicate');
});
