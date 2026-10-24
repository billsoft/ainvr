// A display name/remark is not a new camera view. Keep the source generation
// (or legacy creation identity) stable across cosmetic edits; match BFF exactly.
export interface ZonePreviewSource {id:string;processorId?:string;updatedAt:string;createdAt?:string;inputGeneration?:string}
export function zoneSourceGeometry(source:ZonePreviewSource,width:number,height:number):string|null {
 const created=source.createdAt?Date.parse(source.createdAt):Number.NaN
 if(!source.id||(!source.inputGeneration&&!Number.isFinite(created))||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)return null
 return `source-frame-v2:${source.id}:${source.inputGeneration||new Date(created).toISOString()}:${width}x${height}`
}
