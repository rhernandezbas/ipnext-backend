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
