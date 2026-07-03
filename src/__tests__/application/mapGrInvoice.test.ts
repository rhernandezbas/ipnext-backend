import { mapGrInvoice, deriveInvoiceStatus, parseGrInvoiceDate } from '@application/use-cases/mapGrInvoice';
import { GrInvoice } from '@domain/entities/gestionReal';

function makeGrInvoice(overrides: Partial<GrInvoice> = {}): GrInvoice {
  return {
    tipo: 'FB',
    sucursal: '00010',
    numero: '000074035',
    moneda: 'PES',
    fecha: '26-06-2026',
    fechaVto: '07-07-2026',
    importe: 35121.37,
    saldo: 35121.37,
    urlPdf: 'https://pdf',
    cuponPdf: 'https://cupon',
    paymentUrl: 'https://mp',
    ...overrides,
  };
}

describe('parseGrInvoiceDate (TZ Argentina)', () => {
  it('parses "07-07-2026" to Argentina midnight (03:00 UTC — day NOT shifted)', () => {
    const d = parseGrInvoiceDate('07-07-2026');
    // AR is UTC-3 year-round → midnight AR == 03:00Z on the SAME calendar day.
    expect(d?.toISOString()).toBe('2026-07-07T03:00:00.000Z');
  });

  it('returns null on missing/malformed input', () => {
    expect(parseGrInvoiceDate(null)).toBeNull();
    expect(parseGrInvoiceDate('')).toBeNull();
    expect(parseGrInvoiceDate('2026-07-07')).toBeNull(); // wrong format (not DD-MM-YYYY)
    expect(parseGrInvoiceDate('garbage')).toBeNull();
    expect(parseGrInvoiceDate('31-02-2026')).toBeNull(); // impossible date — rejected, no JS rollover (review #5)
    expect(parseGrInvoiceDate('32-01-2026')).toBeNull(); // day out of range
  });
});

describe('deriveInvoiceStatus (AD-2)', () => {
  // 2026-07-07T12:00:00Z == 09:00 AR on 2026-07-07 → today(AR) = 2026-07-07.
  const now = new Date('2026-07-07T12:00:00Z');

  it('saldo <= 0 → pagada', () => {
    expect(deriveInvoiceStatus(0, parseGrInvoiceDate('01-01-2020'), now)).toBe('pagada');
  });

  it('negative saldo (credit note) → pagada', () => {
    expect(deriveInvoiceStatus(-500, parseGrInvoiceDate('01-01-2020'), now)).toBe('pagada');
  });

  it('saldo > 0 and due date in the future → pendiente', () => {
    expect(deriveInvoiceStatus(100, parseGrInvoiceDate('08-07-2026'), now)).toBe('pendiente');
  });

  it('saldo > 0 and due date in the past → vencida', () => {
    expect(deriveInvoiceStatus(100, parseGrInvoiceDate('06-07-2026'), now)).toBe('vencida');
  });

  it('border: due date == today(AR) → pendiente (inclusive)', () => {
    expect(deriveInvoiceStatus(100, parseGrInvoiceDate('07-07-2026'), now)).toBe('pendiente');
  });

  it('TZ correctness: late-night UTC window uses AR calendar day', () => {
    // 2026-07-07T02:00:00Z == 23:00 AR on 2026-07-06 → today(AR) = 2026-07-06.
    const lateNightUtc = new Date('2026-07-07T02:00:00Z');
    // Due 06-07-2026 == today in AR → pendiente, NOT vencida (would be wrong if UTC-derived).
    expect(deriveInvoiceStatus(100, parseGrInvoiceDate('06-07-2026'), lateNightUtc)).toBe('pendiente');
  });
});

describe('mapGrInvoice', () => {
  const now = new Date('2026-07-07T12:00:00Z');

  it('maps a GR invoice into a persistable shape with composite id + derived status', () => {
    const m = mapGrInvoice(makeGrInvoice(), now);
    expect(m.grInvoiceId).toBe('FB-00010-000074035');
    expect(m.number).toBe('000074035');
    expect(m.grType).toBe('FB');
    expect(m.currency).toBe('PES');
    expect(m.amount).toBe(35121.37);
    expect(m.balance).toBe(35121.37);
    expect(m.issueDate?.toISOString()).toBe('2026-06-26T03:00:00.000Z');
    expect(m.dueDate?.toISOString()).toBe('2026-07-07T03:00:00.000Z');
    expect(m.status).toBe('pendiente'); // saldo>0, vto today → pendiente
    expect(m.pdfUrl).toBe('https://pdf');
    expect(m.couponPdfUrl).toBe('https://cupon');
    expect(m.paymentUrl).toBe('https://mp');
  });

  it('derives vencida when the balance is due in the past', () => {
    const m = mapGrInvoice(makeGrInvoice({ fechaVto: '01-06-2026' }), now);
    expect(m.status).toBe('vencida');
  });

  it('derives pagada when saldo is 0', () => {
    const m = mapGrInvoice(makeGrInvoice({ saldo: 0 }), now);
    expect(m.status).toBe('pagada');
  });
});
