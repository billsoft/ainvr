import {z} from 'zod';
export const presetSelection=z.object({binding_mode:z.literal('preset'),
 preset_id:z.string().min(1).max(256),preset_fingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export type PresetSelection=z.infer<typeof presetSelection>;
export interface PresetHome {
 resource:string;motor:string;identity:string;preset_id:string;preset_name:string;
 preset_fingerprint:string;definition_version:string;pose:unknown;
}
export const presetDefinitionLock="SELECT pg_advisory_xact_lock(hashtextextended('arming-preset-definition',0))";
