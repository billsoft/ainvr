import { describe, expect, it } from 'vitest';
import { searchModelMigrationAdmission } from '../app.js';

const native = { implemented: true, source_ingestion_gate: true, target_write: true, artifacts: true };
const ai = { implemented: true };

describe('production model migration admission', () => {
  it.each([undefined, '', '0', 'false', 'true', '01', ' 1', '1 '])(
    'keeps new migrations disabled without the exact explicit opt-in: %s', value => {
      expect(searchModelMigrationAdmission(value, native, ai)).toBe(false);
    },
  );
  it('still requires every real Native and AI capability after opt-in', () => {
    expect(searchModelMigrationAdmission('1', native, ai)).toBe(true);
    for (const capability of Object.keys(native) as (keyof typeof native)[]) {
      expect(searchModelMigrationAdmission('1', { ...native, [capability]: false }, ai)).toBe(false);
    }
    expect(searchModelMigrationAdmission('1', native, { implemented: false })).toBe(false);
  });
});