/**
 * bulk-csv-recipients (B1.4) — `assertHasRecipients` gana un 3er componente:
 * `manualContacts` (normalizado). Una campaña es válida si hay segmento con
 * criterio real, O lista manual no vacía, O `manualContacts` no vacío —
 * cualquier combinación. Solo rechaza (`UnfilteredSegmentError`) cuando LOS
 * TRES están vacíos.
 */
import { assertHasRecipients } from '@application/use-cases/messaging/assertHasRecipients';
import { UnfilteredSegmentError } from '@domain/errors/messaging-bulk';

describe('assertHasRecipients (3er componente: manualContacts)', () => {
  it('segmento sin criterio + sin manuales + manualContacts NO vacío → NO lanza', () => {
    expect(() => assertHasRecipients({ statuses: [] }, [], [{ name: 'Ana', phone: '11234' }])).not.toThrow();
  });

  it('segmento sin criterio + sin manuales + manualContacts vacío → UnfilteredSegmentError (no-regresión)', () => {
    expect(() => assertHasRecipients({ statuses: [] }, [], [])).toThrow(UnfilteredSegmentError);
  });

  it('segmento sin criterio + sin manuales + manualContacts OMITIDO (default) → UnfilteredSegmentError', () => {
    expect(() => assertHasRecipients({ statuses: [] }, [])).toThrow(UnfilteredSegmentError);
  });

  it('segmento con criterio + sin manuales + sin manualContacts → NO lanza (no-regresión MAN-2/FIX-8)', () => {
    expect(() => assertHasRecipients({ statuses: ['late'] }, [], [])).not.toThrow();
  });

  it('sin segmento + manualClientIds no vacío + sin manualContacts → NO lanza (no-regresión MAN-2)', () => {
    expect(() => assertHasRecipients({ statuses: [] }, ['c1'], [])).not.toThrow();
  });
});

/**
 * bulk-task-recipients (B4.5, TASK-1) — `assertHasRecipients` gana un 4to
 * componente: `taskStageIds`. Válido si `manualClientIds.length>0` O
 * `manualContacts.length>0` O `taskStageIds.length>0` O segmento con criterio
 * real; se rechaza (`UnfilteredSegmentError`) SOLO si los CUATRO están vacíos.
 */
describe('assertHasRecipients (4to componente: taskStageIds)', () => {
  it('sin segmento + sin manuales + sin csv + taskStageIds NO vacío → NO lanza (campaña solo-tarea válida)', () => {
    expect(() => assertHasRecipients({ statuses: [] }, [], [], ['stageA'])).not.toThrow();
  });

  it('los CUATRO vacíos (taskStageIds OMITIDO, default) → UnfilteredSegmentError', () => {
    expect(() => assertHasRecipients({ statuses: [] }, [], [])).toThrow(UnfilteredSegmentError);
  });

  it('los CUATRO vacíos EXPLÍCITOS (taskStageIds: []) → UnfilteredSegmentError', () => {
    expect(() => assertHasRecipients({ statuses: [] }, [], [], [])).toThrow(UnfilteredSegmentError);
  });
});
