/**
 * suricata-bot-autonomous-actions (Phase A, task A.4, design D1.a/D1.b) —
 * TDD RED for `src/domain/entities/suricataBotAction.ts`'s discriminated
 * union. An unknown/malformed `actionType` MUST be rejected by the union's
 * own mapper (`isSuricataBotActionPayload`), never by the DB (D1.a); each of
 * the 4 known payload shapes MUST round-trip (including through a JSON
 * round-trip, since `payload` is stored as a Prisma `Json` column).
 */
import {
  isSuricataBotActionPayload,
  SuricataBotActionPayload,
} from '@domain/entities/suricataBotAction';

describe('suricataBotAction — discriminated union payload (A.3/A.4, design D1.a/D1.b)', () => {
  const validPayloads: SuricataBotActionPayload[] = [
    { actionType: 'reply', body: 'Hola, gracias por tu paciencia' },
    { actionType: 'close', reason: 'Reclamo resuelto' },
    { actionType: 'status', status: 'en_progreso' },
    { actionType: 'note', text: 'Nota interna de seguimiento' },
  ];

  it.each(validPayloads)('round-trips the $actionType payload shape through the mapper', (payload) => {
    expect(isSuricataBotActionPayload(payload)).toBe(true);
    // JSON round-trip — `payload` is stored as a Prisma `Json` column (D1.a),
    // so the mapper must still accept it after a plain serialize/deserialize.
    const roundTripped: unknown = JSON.parse(JSON.stringify(payload));
    expect(isSuricataBotActionPayload(roundTripped)).toBe(true);
    expect(roundTripped).toEqual(payload);
  });

  it('rejects an unknown actionType — never reaches the DB (D1.a)', () => {
    expect(isSuricataBotActionPayload({ actionType: 'delete', foo: 'bar' })).toBe(false);
  });

  it('rejects a malformed payload for a known actionType (wrong field type or missing field)', () => {
    expect(isSuricataBotActionPayload({ actionType: 'reply', body: 123 })).toBe(false);
    expect(isSuricataBotActionPayload({ actionType: 'close' })).toBe(false);
    expect(isSuricataBotActionPayload({ actionType: 'status', status: null })).toBe(false);
    expect(isSuricataBotActionPayload({ actionType: 'note', text: undefined })).toBe(false);
  });

  it('rejects non-object values', () => {
    expect(isSuricataBotActionPayload(null)).toBe(false);
    expect(isSuricataBotActionPayload('reply')).toBe(false);
    expect(isSuricataBotActionPayload(undefined)).toBe(false);
    expect(isSuricataBotActionPayload(42)).toBe(false);
  });
});
