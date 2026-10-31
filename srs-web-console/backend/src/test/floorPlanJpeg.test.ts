import { describe, expect, it } from 'vitest';
import { parseFloorPlanJpeg } from '../services/floorPlanImages.js';

// Synthetic inputs are rejection probes, not claimed decodable images.
const segment=(marker:number,data:number[])=>Buffer.from([255,marker,(data.length+2)>>8,(data.length+2)&255,...data]);
function probe(options:{quant?:boolean;huffman?:boolean;entropy?:number[];component?:number;tables?:number;counts?:number[];scan?:number[]}={}) {
  const counts=options.counts ?? [1,...Array(15).fill(0)];
  const pieces=[Buffer.from([255,216])];
  if (options.quant !== false) pieces.push(segment(0xdb,[0,...Array(64).fill(1)]));
  pieces.push(segment(0xc0,[8,0,1,0,1,1,1,0x11,0]));
  if (options.huffman !== false)
    pieces.push(segment(0xc4,[0,...counts,0,0x10,...counts,0]));
  pieces.push(segment(0xda,options.scan ?? [1,options.component ?? 1,options.tables ?? 0,0,63,0]));
  pieces.push(Buffer.from(options.entropy ?? [1]),Buffer.from([255,217]));
  return 'data:image/jpeg;base64,'+Buffer.concat(pieces).toString('base64');
}
describe('bounded JPEG structural validation',()=>{
  it('rejects frame/scan/end marker shells without quantization or Huffman tables',()=>{
    expect(()=>parseFloorPlanJpeg(probe({quant:false,huffman:false}),1,1)).toThrow();
    expect(()=>parseFloorPlanJpeg(probe({quant:false}),1,1)).toThrow();
    expect(()=>parseFloorPlanJpeg(probe({huffman:false}),1,1)).toThrow();
  });
  it('rejects empty entropy, unknown components and undefined table selectors',()=>{
    expect(()=>parseFloorPlanJpeg(probe({entropy:[]}),1,1)).toThrow();
    expect(()=>parseFloorPlanJpeg(probe({component:2}),1,1)).toThrow();
    expect(()=>parseFloorPlanJpeg(probe({tables:0x11}),1,1)).toThrow();
    expect(()=>parseFloorPlanJpeg(probe({scan:[0,0,63,0]}),1,1)).toThrow();
    expect(()=>parseFloorPlanJpeg(probe({scan:[2,1,0,1,0,0,63,0]}),1,1)).toThrow();
  });
  it('rejects malformed Huffman code counts, scan progression and unauthorized restart markers',()=>{
    expect(()=>parseFloorPlanJpeg(probe({counts:[3,...Array(15).fill(0)]}),1,1)).toThrow();
    expect(()=>parseFloorPlanJpeg(probe({counts:Array(16).fill(0)}),1,1)).toThrow();
    expect(()=>parseFloorPlanJpeg(probe({scan:[1,1,0,1,63,0]}),1,1)).toThrow();
    expect(()=>parseFloorPlanJpeg(probe({entropy:[255,208,1]}),1,1)).toThrow();
  });
});
