import type { ConversationRepository, ConversationListQuery } from '@domain/ports/ConversationRepository';
import type { InboxViewCountsDto } from '@application/dto/messaging';

/**
 * GetInboxViewCounts (inbox-views Ola 1, COUNT-1) — contadores por vista del
 * inbox para los badges de la sidebar: `{ mine, unattended, all, unassigned,
 * resolved, mentioned }`. Seis `ConversationRepository.count` disparados EN PARALELO
 * (`Promise.all` — un solo roundtrip lógico, seis `COUNT` triviales sobre
 * índices; los buckets SOLAPAN entre sí — mine ⊆ all, unattended ⊆ all — así
 * que un único `groupBy` no puede derivarlos sin `$queryRaw` con FILTER, que
 * rompería la simetría in-memory/Prisma del port).
 *
 * note-mentions (Ola 6b) — `mentioned` = conversaciones con una @mención NO leída del user
 * autenticado (mismo filtro `mentionedUserId` que `?view=mentioned` del listado). NO se acopla
 * a `status` (la vista Menciones muestra resueltas también) → NO solapa limpio con `all`.
 *
 * Una sola fuente de verdad con el listado: cada bucket es EXACTAMENTE el
 * `ConversationListQuery` que la vista equivalente del listado usa
 * (`status:'open'` = bucket LS-1 no-resuelta; `unattended:true` = VIEW-1), y en
 * ambos adapters `count` comparte el builder de filtros con `list` — el número
 * del badge no puede divergir de lo que el listado devuelve.
 */
export class GetInboxViewCounts {
  constructor(private readonly conversationRepo: ConversationRepository) {}

  async execute(userId: string): Promise<InboxViewCountsDto> {
    // Guard: sin userId, `{ status:'open', assigneeId: '' }` degeneraría en el
    // bucket `all` (assigneeId falsy → filtro no aplicado en los adapters).
    // Jamás mentir un mine inflado — 0 honesto.
    const mineQuery: ConversationListQuery | null = userId
      ? { status: 'open', assigneeId: userId }
      : null;
    // note-mentions (Ola 6b) — mismo guard que `mine`: sin userId, `{ mentionedUserId: '' }`
    // degeneraría (filtro no aplicado en los adapters → contaría de más). 0 honesto.
    const mentionedQuery: ConversationListQuery | null = userId ? { mentionedUserId: userId } : null;

    const [all, mine, unassigned, unattended, resolved, mentioned] = await Promise.all([
      this.conversationRepo.count({ status: 'open' }),
      mineQuery ? this.conversationRepo.count(mineQuery) : Promise.resolve(0),
      this.conversationRepo.count({ status: 'open', unassigned: true }),
      this.conversationRepo.count({ unattended: true }),
      this.conversationRepo.count({ status: 'resolved' }),
      mentionedQuery ? this.conversationRepo.count(mentionedQuery) : Promise.resolve(0),
    ]);

    return { mine, unattended, all, unassigned, resolved, mentioned };
  }
}
