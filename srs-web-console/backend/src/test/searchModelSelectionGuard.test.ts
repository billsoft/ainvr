import {expect,it,vi} from 'vitest';
import {assertSearchModelSelectionChange} from '../services/searchModelSelectionGuard.js';
const model={package_id:'original',package_sha256:'a'.repeat(64),model_version:`search-v1-${'a'.repeat(64)}`};
const baseline={enabled:true,model:{package_id:'original'}};
const replacement={enabled:true,model:{package_id:'replacement'}};
function fixture(active:unknown=null,known=false){return {query:vi.fn(async(sql:string)=>({rows:sql.includes('to_jsonb')?(active?[{active_model:active}]:[]):known?[{id:'history'}]:[]}))};}
it('ordinary saves cannot replace an actually pinned model, even after clearing a draft selection',async()=>{
  await expect(assertSearchModelSelectionChange(fixture(model),baseline,replacement)).rejects.toThrow('准备模型迁移');
  await expect(assertSearchModelSelectionChange(fixture(model),{enabled:false,model:{package_id:null}},replacement)).rejects.toThrow('准备模型迁移');
});
it('first disabled/unconfigured setup keeps normal model selection without creating a migration',async()=>{
  await expect(assertSearchModelSelectionChange(fixture(),{enabled:false,model:{package_id:'default'}},replacement)).resolves.toBeUndefined();
  await expect(assertSearchModelSelectionChange(fixture(),{},replacement)).resolves.toBeUndefined();
});
it('paused legacy history still requires migration, while an empty disabled source may be initialized',async()=>{
  await expect(assertSearchModelSelectionChange(fixture(null,true),{...baseline,enabled:false},replacement)).rejects.toThrow('准备模型迁移');
  await expect(assertSearchModelSelectionChange(fixture(),baseline,replacement)).rejects.toThrow('准备模型迁移');
});
it('permits repair to the actual old source and disabling does not erase its pin',async()=>{
  await expect(assertSearchModelSelectionChange(fixture(model),replacement,baseline)).resolves.toBeUndefined();
  const f=fixture(model);await expect(assertSearchModelSelectionChange(f,baseline,{enabled:false,model:{package_id:null}})).resolves.toBeUndefined();
  expect(f.query).not.toHaveBeenCalled();
});
