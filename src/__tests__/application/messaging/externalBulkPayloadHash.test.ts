/**
 * external-bulk-messaging (1.8, D5 — actualizado con variables por-recipient
 * VAL-10/D4.e) — `externalBulkPayloadHash`. Pura, total, sin deps de infra.
 * Anti-replay con payload distinto: el mismo lote lógico (mismos recipients/
 * variables globales+por-recipient/label/template, en cualquier orden/formato)
 * produce el MISMO hash; cualquier dato realmente distinto produce OTRO. Que
 * las variables por-recipient entren al hash es lo que impide validar un lote
 * inocuo y mutar los datos personales antes del `send` (D5).
 */
import {
  externalBulkPayloadHash,
  ExternalBulkPayloadHashRecipient,
} from '@application/use-cases/messaging/externalBulkPayloadHash';

const BASE = {
  templateName: 'recordatorio_deuda',
  variables: { '1': 'placeholder' },
  chatwootLabel: 'promo-agosto' as string | null,
  recipients: [
    { phone: '3364111111', name: 'Ana', variables: { '2': '1500' } },
    { phone: '3364222222', name: 'Beto', variables: { '2': '900' } },
  ],
};

describe('externalBulkPayloadHash', () => {
  it('es determinístico: el MISMO input produce SIEMPRE el mismo hash', () => {
    expect(externalBulkPayloadHash(BASE)).toBe(externalBulkPayloadHash({ ...BASE }));
  });

  it('el orden de los recipients es IRRELEVANTE (mismo hash)', () => {
    const reordered = { ...BASE, recipients: [...BASE.recipients].reverse() };
    expect(externalBulkPayloadHash(BASE)).toBe(externalBulkPayloadHash(reordered));
  });

  it('el orden de las keys de variables GLOBALES es IRRELEVANTE (mismo hash)', () => {
    const withMoreGlobals = { ...BASE, variables: { '1': 'placeholder', '3': 'extra' } };
    const reorderedVars = { ...BASE, variables: { '3': 'extra', '1': 'placeholder' } };
    expect(externalBulkPayloadHash(withMoreGlobals)).toBe(externalBulkPayloadHash(reorderedVars));
  });

  it('el orden de las keys de variables POR-RECIPIENT es IRRELEVANTE (mismo hash)', () => {
    const recipientsA: ExternalBulkPayloadHashRecipient[] = [
      { phone: '3364111111', name: 'Ana', variables: { x: '1', y: '2' } },
      { phone: '3364222222', name: 'Beto', variables: { '2': '900' } },
    ];
    const recipientsB: ExternalBulkPayloadHashRecipient[] = [
      { phone: '3364111111', name: 'Ana', variables: { y: '2', x: '1' } },
      { phone: '3364222222', name: 'Beto', variables: { '2': '900' } },
    ];
    const reorderedRecipientVars = { ...BASE, recipients: recipientsA };
    const sameButReordered = { ...BASE, recipients: recipientsB };
    expect(externalBulkPayloadHash(reorderedRecipientVars)).toBe(externalBulkPayloadHash(sameButReordered));
  });

  it('normaliza teléfonos con normalizePhone — el MISMO número en otro formato produce el MISMO hash', () => {
    const withCountryCode = {
      ...BASE,
      recipients: [
        { phone: '5493364111111', name: 'Ana', variables: { '2': '1500' } },
        { phone: '3364222222', name: 'Beto', variables: { '2': '900' } },
      ],
    };
    expect(externalBulkPayloadHash(BASE)).toBe(externalBulkPayloadHash(withCountryCode));
  });

  it('un teléfono inválido (normalize→null) usa el crudo trimeado — sigue moviendo el hash si cambia', () => {
    const withGarbage = { ...BASE, recipients: [{ phone: '123', variables: {} }] };
    const withOtherGarbage = { ...BASE, recipients: [{ phone: '456', variables: {} }] };
    expect(externalBulkPayloadHash(withGarbage)).not.toBe(externalBulkPayloadHash(withOtherGarbage));
  });

  it('un dígito distinto en un teléfono produce un hash DISTINTO', () => {
    const changed = {
      ...BASE,
      recipients: [
        { phone: '3364111112', name: 'Ana', variables: { '2': '1500' } },
        { phone: '3364222222', name: 'Beto', variables: { '2': '900' } },
      ],
    };
    expect(externalBulkPayloadHash(BASE)).not.toBe(externalBulkPayloadHash(changed));
  });

  it('cambiar el `variables` de UN recipient produce un hash DISTINTO (VAL-10)', () => {
    const changed = {
      ...BASE,
      recipients: [
        { phone: '3364111111', name: 'Ana', variables: { '2': '1501' } },
        { phone: '3364222222', name: 'Beto', variables: { '2': '900' } },
      ],
    };
    expect(externalBulkPayloadHash(BASE)).not.toBe(externalBulkPayloadHash(changed));
  });

  it('cambiar SOLO el `name` de un recipient produce el MISMO hash (es cosmético)', () => {
    const changedName = {
      ...BASE,
      recipients: [
        { phone: '3364111111', name: 'Ana Cambiada', variables: { '2': '1500' } },
        { phone: '3364222222', name: 'Beto', variables: { '2': '900' } },
      ],
    };
    expect(externalBulkPayloadHash(BASE)).toBe(externalBulkPayloadHash(changedName));
  });

  it('dos entradas del MISMO teléfono con variables DISTINTAS no colapsan (hashes distintos)', () => {
    const a = { ...BASE, recipients: [{ phone: '3364111111', variables: { '2': '100' } }] };
    const b = { ...BASE, recipients: [{ phone: '3364111111', variables: { '2': '200' } }] };
    expect(externalBulkPayloadHash(a)).not.toBe(externalBulkPayloadHash(b));
  });

  it('un valor de variable GLOBAL distinto produce un hash DISTINTO', () => {
    const changed = { ...BASE, variables: { '1': 'otro-placeholder' } };
    expect(externalBulkPayloadHash(BASE)).not.toBe(externalBulkPayloadHash(changed));
  });

  it('chatwootLabel AUSENTE (undefined) y null producen el MISMO hash', () => {
    const withUndefined = { ...BASE, chatwootLabel: undefined as unknown as null };
    const withNull = { ...BASE, chatwootLabel: null };
    expect(externalBulkPayloadHash(withUndefined)).toBe(externalBulkPayloadHash(withNull));
  });

  it('un chatwootLabel DISTINTO produce un hash DISTINTO', () => {
    const changed = { ...BASE, chatwootLabel: 'otro-label' };
    expect(externalBulkPayloadHash(BASE)).not.toBe(externalBulkPayloadHash(changed));
  });

  it('un templateName distinto produce un hash DISTINTO', () => {
    const changed = { ...BASE, templateName: 'otro_template' };
    expect(externalBulkPayloadHash(BASE)).not.toBe(externalBulkPayloadHash(changed));
  });
});
