import { createHash } from 'crypto';

/**
 * suricata-tickets-mirror (Phase C, D6.b) — the fields whose canonical render
 * decides whether a ticket "changed" since the last sync. `messageCount`
 * (NOT a per-message digest) is what makes this order-independent: the
 * ticket LIST view already reports it (`SuricataTicketSummary.messageCount`),
 * so the hash can be computed WITHOUT opening the ticket detail — that is the
 * whole performance point of D6.b ("si el hash no cambió, no se abre el
 * detalle").
 */
export interface SuricataContentHashInput {
  subject: string;
  status: string;
  priority: string | null;
  areaExternalId: string | null;
  lastMessageAt: string | null;
  messageCount: number;
}

/** Pure function — same input always produces the same sha256 hex digest. */
export function computeSuricataContentHash(input: SuricataContentHashInput): string {
  const canonical = [
    input.subject,
    input.status,
    input.priority ?? '',
    input.areaExternalId ?? '',
    input.lastMessageAt ?? '',
    String(input.messageCount),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}
