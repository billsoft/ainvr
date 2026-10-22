import {render,screen,fireEvent,waitFor} from '@testing-library/react'
import {it,expect,vi} from 'vitest'
import {ZoneEditor} from './WorkspaceEditorHarness'
import {zoneGeometryError} from '@/features/alarmGeometry'
const reference={url:'frame.jpg',width:1920,height:1080,geometryRevision:'g1',capturedAt:'2026-10-19 15:00:00'}
function load(){const img=screen.getByAltText('警戒区原始参考画面');Object.defineProperties(img,{naturalWidth:{value:1920},naturalHeight:{value:1080}});fireEvent.load(img);const svg=screen.getByLabelText('警戒区绘图区域');vi.spyOn(svg.parentElement!,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:1000,height:562.5} as DOMRect);return svg}
it('requires loaded reference and explicit save; rectangle uses normalized source coordinates',async()=>{
  const save=vi.fn().mockResolvedValue(undefined);render(<ZoneEditor reference={reference} onCommit={save} onCancel={()=>{}}/>);
  expect(screen.getByRole('button',{name:'矩形'})).toBeDisabled();const svg=load();
  fireEvent.click(screen.getByRole('button',{name:'矩形'}));fireEvent.click(svg,{clientX:100,clientY:56.25});fireEvent.click(svg,{clientX:800,clientY:450});
  fireEvent.change(screen.getByLabelText('区域名称'),{target:{value:'大门'}});expect(save).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'提交草稿'}));
  await waitFor(()=>expect(save).toHaveBeenCalledOnce());expect(save.mock.calls[0]![0].points).toEqual([[.1,.1],[.8,.1],[.8,.8],[.1,.8]]);
});
it('invalid geometry rejects; keyboard edits undo; source change locks saving',()=>{
  expect(zoneGeometryError([[0,0],[1,1],[0,1],[1,0]])).not.toBe('');
  const props={reference,initial:{name:'门',geometryRevision:'g1',points:[[.1,.1],[.8,.1],[.8,.8]] as [number,number][]},onCommit:vi.fn(),onCancel:vi.fn()};
  const view=render(<ZoneEditor {...props}/>);load();
  fireEvent.keyDown(screen.getByRole('button',{name:/顶点 1/}),{key:'ArrowRight'});expect(screen.getByRole('button',{name:'撤销'})).not.toBeDisabled();
  fireEvent.click(screen.getByRole('button',{name:'撤销'}));
  view.rerender(<ZoneEditor {...props} reference={{...reference,geometryRevision:'g2'}}/>);fireEvent.click(screen.getByRole('button',{name:'提交草稿'}));expect(props.onCommit).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent('来源画面已改变');
});
it('invalid geometry retains the local draft without invoking commit',()=>{
 const commit=vi.fn();render(<ZoneEditor reference={reference} initial={{name:'门',geometryRevision:'g1',points:[[.1,.1],[.8,.1],[.8,.8]]}} onCommit={commit} onCancel={()=>{}}/>);load();
 fireEvent.change(screen.getByLabelText('区域名称'),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'提交草稿'}));
 expect(commit).not.toHaveBeenCalled();expect(screen.getByRole('alert')).toHaveTextContent('名称');
 expect(screen.getAllByRole('button',{name:/顶点 \d+，/})).toHaveLength(3);
});

it('ordinary sources do not offer spherical editing; topology is explicit for panoramic sources',()=>{
 const props={reference,onCommit:vi.fn(),onCancel:vi.fn()};const view=render(<ZoneEditor {...props}/>);load();
 expect(screen.queryByRole('button',{name:'360° 编辑'})).not.toBeInTheDocument();
 view.rerender(<ZoneEditor {...props} panoramaAllowed/>);
 expect(screen.getByRole('button',{name:'360° 编辑'})).toBeEnabled();
 expect(screen.getByText(/平面区域/)).toBeInTheDocument();
});
