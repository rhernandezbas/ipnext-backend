import { createHash } from 'crypto';

/**
 * suricata-tickets-mirror (Phase E, spec suricata-ticket-reply REPLY-2,
 * design D10) — pure sha256-hex helper shared by the use case (recomputes
 * server-side) and, conceptually, the FE (computes the SAME digest
 * client-side before the second confirmation click, Phase I scope). Kept
 * standalone and pure, molde `computeSuricataContentHash` — same input always
 * produces the same digest, no I/O.
 */
export function computeSuricataReplyConfirmation(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}
