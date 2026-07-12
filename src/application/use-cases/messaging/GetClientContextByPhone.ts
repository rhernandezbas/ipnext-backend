import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { ClientContextDto } from '@application/dto/messaging';
import { normalizePhone, suffixMatch } from '@application/use-cases/recapture/matchActiveClient';

/**
 * GetClientContextByPhone (F1, design §4, CTX-1/CTX-2) — matches a conversation's
 * contact phone against `CustomerRepository.listActiveContacts()` by normalized
 * phone suffix. Reuses `normalizePhone`/`suffixMatch` from `matchActiveClient.ts`
 * VERBATIM (design's explicit "SIN reimplementar") instead of re-deriving 24h/phone
 * logic locally.
 *
 * CTX-2 — read-only by construction: the ONLY repository call is `listActiveContacts()`,
 * a read. Nothing here ever calls `create`/`delete`/`updateLocation`, so `Client` and the
 * `Conversation` mirror can never be mutated as a side effect of computing context.
 */
export class GetClientContextByPhone {
  constructor(private readonly customerRepo: CustomerRepository) {}

  async execute(contactPhone: string | null | undefined): Promise<ClientContextDto> {
    const normalized = normalizePhone(contactPhone);
    if (normalized === null) return { status: 'unknown', clients: [] };

    const activeContacts = await this.customerRepo.listActiveContacts();
    const matches = activeContacts.filter((c) => suffixMatch(normalized, normalizePhone(c.phone)));

    if (matches.length === 0) return { status: 'unknown', clients: [] };

    return {
      status: matches.length === 1 ? 'matched' : 'ambiguous',
      clients: matches.map((c) => ({ id: c.id, name: c.name, status: 'active' })),
    };
  }
}
