import { effectiveLabel, IClassStatusCatalogEntry } from '@domain/entities/iclass-status-catalog';

const base: IClassStatusCatalogEntry = {
  id: 'id-1',
  statusCode: '7',
  iclassLabel: 'Concluida',
  displayLabel: null,
  color: null,
  tracked: false,
  prominenseStageId: null,
  lastSyncedAt: new Date(),
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('IClassStatusCatalogEntry — effectiveLabel', () => {
  it('returns iclassLabel when displayLabel is null', () => {
    expect(effectiveLabel(base)).toBe('Concluida');
  });

  it('returns displayLabel when it is set', () => {
    expect(effectiveLabel({ ...base, displayLabel: 'Cerrada' })).toBe('Cerrada');
  });

  it('returns displayLabel even when it is an empty string (edge case)', () => {
    // Empty string is falsy but explicitly set — the spec says displayLabel ?? iclassLabel
    // ?? only skips null/undefined, NOT empty string
    expect(effectiveLabel({ ...base, displayLabel: '' })).toBe('');
  });
});
