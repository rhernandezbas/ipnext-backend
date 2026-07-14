/**
 * messaging-bulk (F2, T3.5) — resolveRecipients: helper puro compartido por
 * PreviewCampaignSegment y CreateCampaign (design §3.3 paso 1, evita duplicar
 * la lógica). Excluye opt-out (SEG-2), descarta teléfono inválido (SEG-4,
 * `toWhatsAppE164 === null`), de-dup por `normalizePhone` VERBATIM ganando el
 * `id` menor (SEG-3).
 */
import { resolveRecipients } from '@application/use-cases/messaging/resolveRecipients';
import type { CampaignRecipientCandidate } from '@domain/ports/CustomerRepository';

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

describe('resolveRecipients', () => {
  it('candidatos válidos y distintos → todos resueltos, contadores en 0', () => {
    const candidates = [
      makeCandidate({ clientId: 'c1', phone: '3364111111' }),
      makeCandidate({ clientId: 'c2', phone: '3364222222' }),
    ];

    const result = resolveRecipients(candidates);

    expect(result.resolved).toHaveLength(2);
    expect(result.excludedOptOut).toBe(0);
    expect(result.excludedNoPhone).toBe(0);
    expect(result.dedupCollapsed).toBe(0);
    expect(result.resolved.map((r) => r.clientId).sort()).toEqual(['c1', 'c2']);
    expect(result.resolved.find((r) => r.clientId === 'c1')?.phoneE164).toBe('+5493364111111');
  });

  it('SEG-2: cliente opt-out se excluye del resuelto y se contabiliza en excludedOptOut', () => {
    const candidates = [
      makeCandidate({ clientId: 'c1', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
      makeCandidate({ clientId: 'c2', whatsappOptOutAt: null }),
    ];

    const result = resolveRecipients(candidates);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].clientId).toBe('c2');
    expect(result.excludedOptOut).toBe(1);
  });

  it('SEG-4: teléfono ausente o basura (toWhatsAppE164 null) se excluye y contabiliza en excludedNoPhone', () => {
    const candidates = [
      makeCandidate({ clientId: 'c1', phone: null }),
      makeCandidate({ clientId: 'c2', phone: '123' }), // menos de 6 dígitos significativos
      makeCandidate({ clientId: 'c3', phone: '3364333333' }),
    ];

    const result = resolveRecipients(candidates);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].clientId).toBe('c3');
    expect(result.excludedNoPhone).toBe(2);
  });

  it('SEG-3: dos clientes que normalizan al mismo teléfono (con/sin código de país) → colapsan a 1, gana el id menor', () => {
    // normalizePhone('3364123456') === normalizePhone('+5493364123456') === '3364123456'
    // (el "54"+"9" se despoja — verbatim de matchActiveClient.ts, sin reimplementar).
    const candidates = [
      makeCandidate({ clientId: 'c2', phone: '+5493364123456' }),
      makeCandidate({ clientId: 'c1', phone: '3364123456' }), // normaliza igual, id menor
    ];

    const result = resolveRecipients(candidates);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].clientId).toBe('c1');
    expect(result.dedupCollapsed).toBe(1);
  });

  it('combinado: opt-out + teléfono inválido + de-dup, todos en el mismo lote', () => {
    const candidates = [
      makeCandidate({ clientId: 'c1', phone: '3364111111', whatsappOptOutAt: null }),
      makeCandidate({ clientId: 'c2', phone: '3364111111', whatsappOptOutAt: null }), // dup de c1
      makeCandidate({ clientId: 'c3', phone: null, whatsappOptOutAt: null }), // teléfono inválido
      makeCandidate({ clientId: 'c4', phone: '3364444444', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }), // opt-out
    ];

    const result = resolveRecipients(candidates);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].clientId).toBe('c1');
    expect(result.excludedOptOut).toBe(1);
    expect(result.excludedNoPhone).toBe(1);
    expect(result.dedupCollapsed).toBe(1);
  });

  it('lista vacía → resolved vacío, todos los contadores en 0, statusCounts vacío', () => {
    const result = resolveRecipients([]);

    expect(result).toEqual({
      resolved: [],
      excludedOptOut: 0,
      excludedNoPhone: 0,
      dedupCollapsed: 0,
      statusCounts: {},
    });
  });

  // ── messaging-bulk v1.1 (preview modal) — statusCounts + status por-destinatario ──
  it('v1.1: propaga el `status` del candidato a cada `ResolvedRecipient`', () => {
    const candidates = [
      makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'late' }),
      makeCandidate({ clientId: 'c2', phone: '3364222222', status: 'blocked' }),
    ];

    const result = resolveRecipients(candidates);

    expect(result.resolved.find((r) => r.clientId === 'c1')?.status).toBe('late');
    expect(result.resolved.find((r) => r.clientId === 'c2')?.status).toBe('blocked');
  });

  it('v1.1: statusCounts cuenta SOLO los RESUELTOS (post opt-out/dedup/teléfono-inválido), agrupados por status', () => {
    const candidates = [
      makeCandidate({ clientId: 'c1', phone: '3364111111', status: 'late' }),
      makeCandidate({ clientId: 'c2', phone: '3364222222', status: 'late' }),
      makeCandidate({ clientId: 'c3', phone: '3364333333', status: 'blocked' }),
      // excluido (opt-out) — NO debe sumar a statusCounts.blocked
      makeCandidate({ clientId: 'c4', phone: '3364444444', status: 'blocked', whatsappOptOutAt: '2026-01-01T00:00:00.000Z' }),
      // excluido (teléfono inválido) — NO debe sumar a statusCounts.late
      makeCandidate({ clientId: 'c5', phone: '123', status: 'late' }),
    ];

    const result = resolveRecipients(candidates);

    expect(result.resolved).toHaveLength(3);
    expect(result.statusCounts).toEqual({ late: 2, blocked: 1 });
  });

  it('v1.1: de-dup por teléfono — el status contado es el del SOBREVIVIENTE (id menor), no se duplica ni se pierde', () => {
    const candidates = [
      makeCandidate({ clientId: 'c2', phone: '+5493364123456', status: 'blocked' }),
      makeCandidate({ clientId: 'c1', phone: '3364123456', status: 'late' }), // normaliza igual, id menor, gana
    ];

    const result = resolveRecipients(candidates);

    expect(result.resolved).toHaveLength(1);
    expect(result.resolved[0].status).toBe('late');
    expect(result.statusCounts).toEqual({ late: 1 });
  });

  it('v1.1: candidato sin `status` (path que no lo completa, ej. re-check per-envío) → cuenta como "unknown", nunca undefined', () => {
    const candidates = [makeCandidate({ clientId: 'c1', phone: '3364111111', status: undefined })];

    const result = resolveRecipients(candidates);

    expect(result.resolved[0].status).toBe('unknown');
    expect(result.statusCounts).toEqual({ unknown: 1 });
  });
});
