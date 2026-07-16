/**
 * bulk-csv-recipients (D3, B2.2) — `matchManualContacts`: vínculo por teléfono
 * contra el universo COMPLETO de `Client` (escape hatch OPT-2,
 * `listSegmentRecipients({statuses: []})`), match EXACTO por `normalizePhone`
 * (no suffix), ambigüedad activo>baja con desempate por clientId menor.
 */
import { matchManualContacts } from '@application/use-cases/messaging/matchManualContacts';
import type { CampaignRecipientCandidate, CampaignSegmentSource, CampaignSegmentFilter } from '@domain/ports/CustomerRepository';

function makeCandidate(overrides: Partial<CampaignRecipientCandidate> = {}): CampaignRecipientCandidate {
  return {
    clientId: 'c-default',
    name: 'Default',
    phone: '3364000000',
    balanceDue: 1000,
    whatsappOptOutAt: null,
    status: 'active',
    ...overrides,
  };
}

function makeSegmentSource(universe: CampaignRecipientCandidate[]): CampaignSegmentSource & { calls: CampaignSegmentFilter[] } {
  const calls: CampaignSegmentFilter[] = [];
  return {
    calls,
    listSegmentRecipients: async (segment: CampaignSegmentFilter) => {
      calls.push(segment);
      return universe;
    },
  };
}

describe('matchManualContacts (D3)', () => {
  it('lista vacía → [] SIN tocar la fuente (cero costo cuando no hay manualContacts)', async () => {
    const source = makeSegmentSource([makeCandidate({ clientId: 'c1' })]);

    const result = await matchManualContacts([], source);

    expect(result).toEqual([]);
    expect(source.calls).toHaveLength(0);
  });

  it('contacto matchea cliente activo → kind "linked" con el candidate del Client', async () => {
    const client = makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'active' });
    const source = makeSegmentSource([client]);

    const result = await matchManualContacts([{ name: 'Ana', phone: '3364111111' }], source);

    expect(result).toEqual([{ kind: 'linked', candidate: client, contactName: 'Ana' }]);
    // escape hatch OPT-2: universo completo, statuses vacío.
    expect(source.calls).toEqual([{ statuses: [] }]);
  });

  it('contacto SIN match → kind "raw" con phoneE164/phoneNormalized calculados', async () => {
    const source = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111' })]);

    const result = await matchManualContacts([{ name: 'Beto', phone: '11 2345-6789' }], source);

    expect(result).toEqual([
      { kind: 'raw', name: 'Beto', phone: '11 2345-6789', phoneNormalized: '1123456789', phoneE164: '+5491123456789' },
    ]);
  });

  it('match EXACTO por normalizePhone, NO suffix — dos NSN que COMPARTEN los últimos 8 dígitos (matchearían con suffixMatch) NO matchean acá', async () => {
    // normalizePhone('3364123456') === '3364123456'; normalizePhone('9964123456') === '9964123456'.
    // Ambos terminan en '64123456' (8 dígitos): PHONE_SUFFIX_LENGTH=8 → `suffixMatch` (el de
    // GetClientContextByPhone) los consideraría el MISMO teléfono. El match EXACTO de D3 no: acá
    // decide OWNERSHIP del envío, un falso positivo manda la deuda de OTRO cliente.
    const client = makeCandidate({ clientId: 'c1', phone: '3364123456' });
    const source = makeSegmentSource([client]);

    const result = await matchManualContacts([{ name: 'Ana', phone: '9964123456' }], source);

    // NO vincula — cae "raw" (crudo), con su PROPIO phoneE164 reconstruido, no el del cliente.
    expect(result).toEqual([
      { kind: 'raw', name: 'Ana', phone: '9964123456', phoneNormalized: '9964123456', phoneE164: '+5499964123456' },
    ]);
  });

  it('name vacío (post-trim) → excluded sin_nombre, SIN intentar match', async () => {
    const source = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111' })]);

    const result = await matchManualContacts([{ name: '', phone: '3364111111' }], source);

    expect(result).toEqual([{ kind: 'excluded', name: '', phone: '3364111111', reason: 'sin_nombre' }]);
  });

  it('phone vacío (post-trim) → excluded sin_telefono', async () => {
    const source = makeSegmentSource([]);

    const result = await matchManualContacts([{ name: 'Ana', phone: '' }], source);

    expect(result).toEqual([{ kind: 'excluded', name: 'Ana', phone: '', reason: 'sin_telefono' }]);
  });

  it('phone con dígitos pero basura → excluded telefono_invalido', async () => {
    const source = makeSegmentSource([]);

    const result = await matchManualContacts([{ name: 'Beto', phone: 'no-es-numero' }], source);

    expect(result).toEqual([{ kind: 'excluded', name: 'Beto', phone: 'no-es-numero', reason: 'telefono_invalido' }]);
  });

  // ── CSV-2: opt-out / baja / ambigüedad ───────────────────────────────────────
  it('contacto matchea cliente CON opt-out → igual "linked" (el caller decide excluir vía compliance, no acá)', async () => {
    const client = makeCandidate({ clientId: 'c1', phone: '3364111111', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' });
    const source = makeSegmentSource([client]);

    const result = await matchManualContacts([{ name: 'Ana', phone: '3364111111' }], source);

    expect(result).toEqual([{ kind: 'linked', candidate: client, contactName: 'Ana' }]);
  });

  it('contacto matchea cliente `baja` (sin opt-out) → "linked" con ese candidate (status baja viaja para el flag)', async () => {
    const client = makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'baja' });
    const source = makeSegmentSource([client]);

    const result = await matchManualContacts([{ name: 'Ana', phone: '3364111111' }], source);

    expect(result).toEqual([{ kind: 'linked', candidate: client, contactName: 'Ana' }]);
  });

  it('ambigüedad: 2 clientes con la MISMA clave normalizada (uno active, uno baja) → gana el ACTIVE', async () => {
    const bajaClient = makeCandidate({ clientId: 'zz', phone: '3364111111', status: 'baja' });
    const activeClient = makeCandidate({ clientId: 'aa', phone: '3364111111', status: 'active' });
    const source = makeSegmentSource([bajaClient, activeClient]);

    const result = await matchManualContacts([{ name: 'Ana', phone: '3364111111' }], source);

    expect(result).toEqual([{ kind: 'linked', candidate: activeClient, contactName: 'Ana' }]);
  });

  it('ambigüedad: mismo criterio sin importar el ORDEN de llegada (active primero, baja después)', async () => {
    const activeClient = makeCandidate({ clientId: 'aa', phone: '3364111111', status: 'active' });
    const bajaClient = makeCandidate({ clientId: 'zz', phone: '3364111111', status: 'baja' });
    const source = makeSegmentSource([activeClient, bajaClient]);

    const result = await matchManualContacts([{ name: 'Ana', phone: '3364111111' }], source);

    expect(result).toEqual([{ kind: 'linked', candidate: activeClient, contactName: 'Ana' }]);
  });

  it('ambigüedad: 2 clientes con la MISMA clave, MISMO status → desempate por clientId MENOR', async () => {
    const c2 = makeCandidate({ clientId: 'c2', phone: '3364111111', status: 'active' });
    const c1 = makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'active' });
    const source = makeSegmentSource([c2, c1]);

    const result = await matchManualContacts([{ name: 'Ana', phone: '3364111111' }], source);

    expect(result).toEqual([{ kind: 'linked', candidate: c1, contactName: 'Ana' }]);
  });

  it('múltiples contactos → una SOLA llamada a listSegmentRecipients (batch, no N+1)', async () => {
    const source = makeSegmentSource([makeCandidate({ clientId: 'c1', phone: '3364111111' })]);

    await matchManualContacts(
      [
        { name: 'Ana', phone: '3364111111' },
        { name: 'Beto', phone: '3364222222' },
      ],
      source,
    );

    expect(source.calls).toHaveLength(1);
  });
});
