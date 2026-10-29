import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {SearchModelMigrationPanel} from '@/pages/ConfigCenter/SearchModelMigrationPanel'
import type {SearchMigrationPlan} from '@/api/searchModelMigrationService'
const api=vi.hoisted(()=>({context:vi.fn(),list:vi.fn(),create:vi.fn(),accept:vi.fn(),activate:vi.fn(),cancel:vi.fn()}))
vi.mock('@/api/searchModelMigrationService',()=>({searchModelMigrationService:api}))
vi.mock('@/utils/operationId',()=>({newOperationId:vi.fn(()=> '00000000-0000-4000-8000-000000000099')}))
const h=(s:string)=>s.repeat(64),source={package_id:'old-model',package_sha256:h('a'),model_version:`search-v1-${h('a')}`},target={package_id:'new-model',package_sha256:h('b'),model_version:`search-v1-${h('b')}`}
const plan=(phase:SearchMigrationPlan['phase']='awaiting_acceptance'):SearchMigrationPlan=>({id:'00000000-0000-4000-8000-000000000001',generation:2,purpose:'reencode_plan',state:'succeeded',phase,source,target,payload_fingerprint:h('c'),extent:{from_ms:null,to_ms:null,source_high_watermark:'0'},source_count:2,expires_at:new Date(Date.now()+86400000).toISOString(),acceptance_criteria_sha256:h('d'),progress:{next_partition:0,total_children:0,round:0,switch_deadline_ms:null},reason:null,accepted_report_sha256:phase==='ready'?h('e'):null})
beforeEach(()=>{vi.clearAllMocks();api.context.mockResolvedValue({source,execution_available:true,reason:null});api.list.mockResolvedValue({items:[]});api.create.mockResolvedValue(plan());api.accept.mockResolvedValue(plan('ready'));api.activate.mockResolvedValue({scheduled:true});api.cancel.mockResolvedValue({cancelled:true})})
afterEach(cleanup)
function show(extra:Partial<Parameters<typeof SearchModelMigrationPanel>[0]>={}){const onRequired=vi.fn(),onActive=vi.fn();render(<SearchModelMigrationPanel target={target.package_id} targetVersion={target.model_version} onRequired={onRequired} onActive={onActive} {...extra}/>);return {onRequired,onActive}}
async function loaded(){await screen.findByText('当前模型：old-model')}
it('requires a controlled criteria reference and keeps the exact UUID/body when a create response was lost',async()=>{
 const f=show();await loaded();expect(f.onRequired).toHaveBeenLastCalledWith(true);
 fireEvent.click(screen.getByText('准备迁移到 new-model · 管理员操作'));
 const button=screen.getByRole('button',{name:'从留存截图准备迁移'});expect(button).toBeDisabled();
 fireEvent.change(screen.getByLabelText('迁移验收标准 SHA-256'),{target:{value:h('f')}});
 api.create.mockRejectedValueOnce(new Error('网络中断，提交尚未确认'));fireEvent.click(button);await screen.findByText('网络中断，提交尚未确认');
 fireEvent.click(button);await waitFor(()=>expect(api.create).toHaveBeenCalledTimes(2));
 expect(api.create.mock.calls[0]).toEqual(api.create.mock.calls[1]);expect(api.create.mock.calls[0]![0]).toEqual({request_id:'00000000-0000-4000-8000-000000000099',target_package_id:'new-model',acceptance_criteria_sha256:h('f')});
 expect(api.activate).not.toHaveBeenCalled();expect(api.accept).not.toHaveBeenCalled();
})
it('implementation not ready disables migration and never turns metadata into a passed quality gate',async()=>{
 api.context.mockResolvedValue({source,execution_available:false,reason:'migration_executor_pending'});show();await loaded();
 fireEvent.click(screen.getByText('准备迁移到 new-model · 管理员操作'));fireEvent.change(screen.getByLabelText('迁移验收标准 SHA-256'),{target:{value:h('f')}});
 expect(screen.getByRole('button',{name:'从留存截图准备迁移'})).toBeDisabled();expect(screen.getByText(/当前服务尚未具备完整安全迁移能力/)).toBeInTheDocument();expect(api.create).not.toHaveBeenCalled();
})
it('accepting a report is a separate administrator action and does not schedule a switch',async()=>{
 const item=plan();api.list.mockResolvedValue({items:[item]});show();await loaded();
 const accept=screen.getByRole('button',{name:'接受已核对的报告'});expect(accept).toBeDisabled();
 fireEvent.change(screen.getByLabelText(`验收报告 SHA-256 ${item.id}`),{target:{value:h('e')}});expect(accept).toBeDisabled();
 fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(accept);
 await waitFor(()=>expect(api.accept).toHaveBeenCalledWith(item,h('e')));expect(api.activate).not.toHaveBeenCalled();
})
it('uses the existing accessible confirmation; closing/Escape never schedules the model switch',async()=>{
 const item=plan('ready');api.list.mockResolvedValue({items:[item]});show();await loaded();
 const open=screen.getByRole('button',{name:'安排切换模型'});open.focus();fireEvent.click(open);expect(screen.getByRole('dialog',{name:'安排切换搜索模型'})).toBeInTheDocument();
 fireEvent.click(screen.getByRole('button',{name:'关闭'}));expect(api.activate).not.toHaveBeenCalled();await waitFor(()=>expect(open).toHaveFocus());
 fireEvent.click(open);fireEvent.keyDown(document,{key:'Escape'});expect(api.activate).not.toHaveBeenCalled();
 fireEvent.click(open);fireEvent.click(screen.getByRole('button',{name:'确认安排切换'}));await waitFor(()=>expect(api.activate).toHaveBeenCalledWith(item));
})
it('a restored source is a terminal new-revision result, not a retry-ready original job',async()=>{
 const item={...plan('restored'),reason:'target_activation_failed'},reload=vi.fn(async()=>undefined);api.list.mockResolvedValue({items:[item]});show({onReload:reload});await loaded();
 expect(screen.getByText('已恢复原模型配置')).toBeInTheDocument();expect(screen.queryByRole('button',{name:'安排切换模型'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'重新读取已生效配置'}));fireEvent.click(screen.getByRole('button',{name:'取消'}));expect(reload).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'重新读取已生效配置'}));fireEvent.click(screen.getByRole('button',{name:'放弃本页输入并读取'}));await waitFor(()=>expect(reload).toHaveBeenCalledOnce());
})
it('read failure preserves existing task facts and explicitly stops mutation rather than saying no tasks',async()=>{
 api.list.mockRejectedValue(new Error('fixture offline'));show();await screen.findByRole('alert');
 expect(screen.queryByText('暂无模型迁移任务。')).toBeNull();expect(api.create).not.toHaveBeenCalled();
})
it('a rejected source writer proof is not presented as resumed sampling or a completed switch',async()=>{
 api.list.mockResolvedValue({items:[{...plan('ready'),reason:'source_writer_uncertain'}]});show();await loaded();
 expect(screen.getByText(/存在未确认的历史写入/)).toHaveTextContent('采集恢复仍需确认');
 expect(screen.queryByText('目标模型已确认就绪')).toBeNull();expect(screen.queryByText('已恢复原模型配置')).toBeNull();expect(api.activate).not.toHaveBeenCalled();
})
it('late responses after unmount do not create a second operation or apply a model',async()=>{
 let resolve!:(value:{items:SearchMigrationPlan[]})=>void;api.list.mockImplementation(()=>new Promise(value=>resolve=value));const onRequired=vi.fn(),onActive=vi.fn();
 const view=render(<SearchModelMigrationPanel target="new-model" targetVersion={target.model_version} onRequired={onRequired} onActive={onActive}/>);view.unmount();
 await act(async()=>{resolve({items:[plan('ready')]})});expect(api.activate).not.toHaveBeenCalled();expect(api.create).not.toHaveBeenCalled();
})
