import { assertSuggestionComplete } from '@domain/services/suggestionCompleteness';
import { IncompleteSuggestionError } from '@domain/errors/inventory';

describe('assertSuggestionComplete', () => {
  // DEVICE — incompleto
  it('DEVICE sin SN ni MAC → lanza IncompleteSuggestionError con mensaje correcto', () => {
    expect(() =>
      assertSuggestionComplete({ id: 's1', kind: 'DEVICE', serialNumber: null, mac: null, materialDesc: null }),
    ).toThrow(IncompleteSuggestionError);

    expect(() =>
      assertSuggestionComplete({ id: 's1', kind: 'DEVICE', serialNumber: null, mac: null, materialDesc: null }),
    ).toThrow('DEVICE requiere SN o MAC');
  });

  it('DEVICE sin SN ni MAC (strings vacíos) → lanza error', () => {
    expect(() =>
      assertSuggestionComplete({ id: 's2', kind: 'DEVICE', serialNumber: '  ', mac: '', materialDesc: null }),
    ).toThrow('DEVICE requiere SN o MAC');
  });

  // DEVICE — completo
  it('DEVICE solo SN → no lanza', () => {
    expect(() =>
      assertSuggestionComplete({ id: 's3', kind: 'DEVICE', serialNumber: 'SN-001', mac: null, materialDesc: null }),
    ).not.toThrow();
  });

  it('DEVICE solo MAC → no lanza', () => {
    expect(() =>
      assertSuggestionComplete({ id: 's4', kind: 'DEVICE', serialNumber: null, mac: 'AA:BB:CC:DD:EE:FF', materialDesc: null }),
    ).not.toThrow();
  });

  it('DEVICE con SN y MAC → no lanza', () => {
    expect(() =>
      assertSuggestionComplete({ id: 's5', kind: 'DEVICE', serialNumber: 'SN-X', mac: 'AA:BB', materialDesc: null }),
    ).not.toThrow();
  });

  // MATERIAL — incompleto
  it('MATERIAL con descripción vacía → lanza IncompleteSuggestionError', () => {
    expect(() =>
      assertSuggestionComplete({ id: 's6', kind: 'MATERIAL', serialNumber: null, mac: null, materialDesc: '' }),
    ).toThrow(IncompleteSuggestionError);

    expect(() =>
      assertSuggestionComplete({ id: 's6', kind: 'MATERIAL', serialNumber: null, mac: null, materialDesc: '' }),
    ).toThrow('MATERIAL requiere descripción');
  });

  it('MATERIAL con descripción null → lanza error', () => {
    expect(() =>
      assertSuggestionComplete({ id: 's7', kind: 'MATERIAL', serialNumber: null, mac: null, materialDesc: null }),
    ).toThrow('MATERIAL requiere descripción');
  });

  it('MATERIAL con descripción solo espacios → lanza error', () => {
    expect(() =>
      assertSuggestionComplete({ id: 's8', kind: 'MATERIAL', serialNumber: null, mac: null, materialDesc: '   ' }),
    ).toThrow('MATERIAL requiere descripción');
  });

  // MATERIAL — completo
  it('MATERIAL con descripción → no lanza', () => {
    expect(() =>
      assertSuggestionComplete({ id: 's9', kind: 'MATERIAL', serialNumber: null, mac: null, materialDesc: 'Cable coaxial 10m' }),
    ).not.toThrow();
  });
});
