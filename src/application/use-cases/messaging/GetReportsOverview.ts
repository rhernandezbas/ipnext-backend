import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ConversationEventRepository } from '@domain/ports/ConversationEventRepository';
import type { GetInboxViewCounts } from './GetInboxViewCounts';
import type { ReportsOverviewDto } from '@application/dto/messagingReports';

/**
 * GetReportsOverview (conversation-events Ola 2, reports/overview) — tiles del dashboard.
 *
 * Los "current" REUSAN `GetInboxViewCounts` (que YA existe) para `currentOpen`(=all)/
 * `currentUnattended`/`currentUnassigned`, más un `count({status:'pending'})` para
 * `currentPending` (que ese use case no expone). Los "inRange": `resolvedInRange` = eventos
 * 'resolved' en `[from,to)` (throughput, coincide con la suma de `resolutions/day`);
 * `createdInRange` = conversaciones con `createdAt` en el rango (columna completa, no eventos).
 *
 * Todo en paralelo (`Promise.all`) — cinco agregaciones triviales sobre índices, un solo
 * roundtrip lógico.
 */
export class GetReportsOverview {
  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly eventRepo: ConversationEventRepository,
    private readonly getInboxViewCounts: GetInboxViewCounts,
  ) {}

  async execute(userId: string, fromIso: string, toIso: string): Promise<ReportsOverviewDto> {
    const [viewCounts, currentPending, resolvedInRange, createdInRange] = await Promise.all([
      this.getInboxViewCounts.execute(userId),
      this.conversationRepo.count({ status: 'pending' }),
      this.eventRepo.countByTypeBetween('resolved', fromIso, toIso),
      this.conversationRepo.countCreatedBetween(fromIso, toIso),
    ]);

    return {
      resolvedInRange,
      createdInRange,
      currentOpen: viewCounts.all,
      currentUnattended: viewCounts.unattended,
      currentUnassigned: viewCounts.unassigned,
      currentPending,
    };
  }
}
