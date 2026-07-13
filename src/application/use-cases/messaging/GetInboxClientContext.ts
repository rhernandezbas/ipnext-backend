import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { TicketRepository } from '@domain/ports/TicketRepository';
import type { Contract } from '@domain/entities/customer';
import { pppoeDisplayStatus, type PppoeDisplayStatus } from '@domain/entities/pppoeService';
import { ClientIdNotACandidateError, ConversationNotFoundError } from '@domain/errors/messaging';
import type {
  InboxClientContextDto,
  InboxClientSummaryDto,
  InboxContractSummaryDto,
  InboxInvoiceSummaryDto,
  InboxLogSummaryDto,
  InboxTaskSummaryDto,
  InboxTicketSummaryDto,
} from '@application/dto/messaging';
import { GetClientContracts } from '@application/use-cases/GetClientContracts';
import { GetClientInvoices } from '@application/use-cases/GetClientInvoices';
import { GetClientLogs } from '@application/use-cases/GetClientLogs';
import { ListTickets } from '@application/use-cases/ListTickets';
import { ListTasks } from '@application/use-cases/ListTasks';
import { ListPppoeByContract } from '@application/use-cases/ListPppoeByContract';
import {
  DEFAULT_BALANCE_STALE_TTL_MINUTES,
  RefreshClientBalanceIfStale,
  isBalanceOlderThanTtl,
} from '@application/use-cases/RefreshClientBalanceIfStale';
import { GetClientContextByPhone } from './GetClientContextByPhone';

/**
 * fix-be #4 — severity ranking for `mostSevereServiceStatus` (lower = worse/more
 * severe). `baja`/`blocked` tie at the top (both mean "sin servicio" for the
 * agent, just via different lifecycle paths — baja is a hard termination,
 * blocked is a soft cut); `reduced` (deudor) beats `active`; `inactive` is the
 * defensive catch-all, least severe by convention (never a real cut state).
 */
const SERVICE_STATUS_SEVERITY: Record<PppoeDisplayStatus, number> = {
  baja: 0,
  blocked: 0,
  reduced: 1,
  active: 2,
  inactive: 3,
};

function mostSevereServiceStatus(statuses: PppoeDisplayStatus[]): PppoeDisplayStatus {
  return statuses.reduce((worst, s) =>
    SERVICE_STATUS_SEVERITY[s] < SERVICE_STATUS_SEVERITY[worst] ? s : worst,
  );
}

export interface GetInboxClientContextOptions {
  now?: () => Date;
  /** TTL in minutes before a balance is considered stale. Default: 60 (same as
   * RefreshClientBalanceIfStale — DEFAULT_BALANCE_STALE_TTL_MINUTES). */
  ttlMinutes?: number;
}

export interface GetInboxClientContextParams {
  /** Only used to disambiguate an `ambiguous` match — MUST be one of that phone's candidates. */
  clientId?: string;
  /** RICH-4 — when true, awaits a live GR balance refresh (TTL-gated, up to ~4s). */
  refresh?: boolean;
}

/**
 * GetInboxClientContext (messaging-inbox-v2 F1.5, RICH-1..6) — on-demand rich
 * aggregate for the inbox's "client context" panel (a SUMMARY, never a clone of
 * the ficha — proposal.md). Lazy: only called when the FE expands the panel,
 * NEVER inlined into `GetConversation`'s fetch-on-open hot path.
 *
 * RICH-1 — re-resolves the phone match for the given conversation via
 * `GetClientContextByPhone` (same collaborator `GetConversation` already uses)
 * instead of trusting a bare `clientId`: the match stays server-side authority,
 * so `messaging:read` can never be used to pull an arbitrary client's data.
 *
 * RICH-2 — fans out, via `Promise.all`, to use cases ALREADY tested elsewhere
 * (`GetClientContracts`/`GetClientInvoices`/`GetClientLogs`/`ListTickets`/
 * `ListTasks`/`ListPppoeByContract` per contract). Every collaborator is wrapped
 * in its OWN try/catch — a failing section degrades to empty/null; it never
 * takes down the rest of the response.
 *
 * RICH-4 — balance is stale-while-revalidate. The DEFAULT path (no `refresh`)
 * reads the mirror directly (`customerRepo.findById`) and computes `balance.stale`
 * via the pure `isBalanceOlderThanTtl` helper (B2) — SAME TTL rule as
 * `RefreshClientBalanceIfStale`, but evaluated locally, WITHOUT calling Gestión
 * Real. `?refresh=true` invokes the real collaborator (TTL-gated, swallows GR
 * errors — same contract it already has in `GetClientDetail`).
 *
 * Deviation from the tasks.md draft signature (documented, concrete reason):
 * adds `ticketRepo: TicketRepository` — RICH-3's "openTicketsCount must come
 * from `countOpenByClientIds`, never `.length` of the truncated list" cannot be
 * satisfied through `ListTickets` alone (it only wraps `TicketRepository.list()`).
 */
export class GetInboxClientContext {
  private readonly now: () => Date;
  private readonly ttlMinutes: number;

  constructor(
    private readonly conversationRepo: ConversationRepository,
    private readonly getClientContextByPhone: GetClientContextByPhone,
    private readonly customerRepo: CustomerRepository,
    private readonly getContracts: GetClientContracts,
    private readonly getInvoices: GetClientInvoices,
    private readonly getLogs: GetClientLogs,
    private readonly listTickets: ListTickets,
    private readonly ticketRepo: TicketRepository,
    private readonly listTasks: ListTasks,
    private readonly listPppoeByContract: ListPppoeByContract,
    private readonly refreshBalance?: RefreshClientBalanceIfStale,
    opts: GetInboxClientContextOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.ttlMinutes = opts.ttlMinutes ?? DEFAULT_BALANCE_STALE_TTL_MINUTES;
  }

  async execute(conversationId: string, params?: GetInboxClientContextParams): Promise<InboxClientContextDto> {
    const conversation = await this.conversationRepo.findById(conversationId);
    if (!conversation) throw new ConversationNotFoundError(conversationId);

    const phoneContext = await this.getClientContextByPhone.execute(conversation.contactPhone);

    if (phoneContext.status === 'unknown') {
      return { status: 'unknown' };
    }

    if (phoneContext.status === 'ambiguous') {
      const chosenId = params?.clientId;
      if (!chosenId) {
        return { status: 'ambiguous', candidates: phoneContext.clients };
      }
      const isCandidate = phoneContext.clients.some((c) => c.id === chosenId);
      if (!isCandidate) {
        throw new ClientIdNotACandidateError(chosenId, conversationId);
      }
      const client = await this.buildClientSummary(chosenId, params?.refresh === true);
      return { status: 'matched', client };
    }

    // matched — GetClientContextByPhone guarantees exactly one entry here.
    const targetClientId = phoneContext.clients[0].id;
    const client = await this.buildClientSummary(targetClientId, params?.refresh === true);
    return { status: 'matched', client };
  }

  private async buildClientSummary(clientId: string, refresh: boolean): Promise<InboxClientSummaryDto> {
    let customer = await this.customerRepo.findById(clientId);

    // RICH-4 — live refresh ONLY when the caller explicitly asks for it. On the
    // default path this branch never runs (tests #8/#9 assert zero invocations).
    if (refresh && this.refreshBalance && customer.grClienteId) {
      const refreshed = await this.refreshBalance.execute({
        grClienteId: customer.grClienteId,
        lastBalanceAt: customer.lastBalanceAt,
      });
      if (refreshed) {
        customer = await this.customerRepo.findById(clientId);
      }
    }

    const due = customer.balanceDue ?? null;
    const stale = isBalanceOlderThanTtl(customer.lastBalanceAt, this.ttlMinutes, this.now);

    // RICH-2 — fan-out via Promise.all: a slow collaborator never serializes the
    // rest (spec scenario "un colaborador lento no serializa a los demas").
    const [contracts, invoiceSummary, recentLogs, ticketsSummary, tasksSummary] = await Promise.all([
      this.safeContracts(clientId),
      this.safeInvoices(clientId),
      this.safeLogs(clientId),
      this.safeTickets(clientId),
      this.safeTasks(clientId),
    ]);

    return {
      id: customer.id,
      name: customer.name,
      email: customer.email ?? null,
      phone: customer.phone ?? null,
      status: customer.status,
      fichaClientId: customer.id,
      balance: {
        due,
        currency: customer.balanceCurrency ?? null,
        isDebtor: due != null && due > 0,
        stale,
        lastRefreshedAt: customer.lastBalanceAt ?? null,
      },
      lastInvoice: invoiceSummary.lastInvoice,
      nextDueDate: invoiceSummary.nextDueDate,
      contracts,
      openTicketsCount: ticketsSummary.openTicketsCount,
      recentTickets: ticketsSummary.recentTickets,
      closedTicketsCount: ticketsSummary.closedTicketsCount,
      recentClosedTickets: ticketsSummary.recentClosedTickets,
      openTasksCount: tasksSummary.openTasksCount,
      recentTasks: tasksSummary.recentTasks,
      closedTasksCount: tasksSummary.closedTasksCount,
      recentClosedTasks: tasksSummary.recentClosedTasks,
      recentLogs,
    };
  }

  private async safeContracts(clientId: string): Promise<InboxContractSummaryDto[]> {
    try {
      const contracts = await this.getContracts.execute(clientId);
      return await Promise.all(contracts.map((c) => this.mapContractWithServiceStatus(c)));
    } catch {
      return [];
    }
  }

  private async mapContractWithServiceStatus(contract: Contract): Promise<InboxContractSummaryDto> {
    let serviceStatus: InboxContractSummaryDto['serviceStatus'] = null;
    try {
      const services = await this.listPppoeByContract.execute(contract.id);
      // Contract:PppoeService is 1:N (a contract CAN have more than one PPPoE
      // service) but the DTO wants exactly ONE serviceStatus per contract.
      // fix-be #4 — the repo's return order is NOT deterministic, so taking
      // services[0] could show 'active' when a sibling service is actually
      // 'blocked'. Collapse to the MOST SEVERE status instead (see
      // SERVICE_STATUS_SEVERITY below).
      if (services.length > 0) {
        const statuses = services.map((s) => pppoeDisplayStatus(s.status, s.enforcedState));
        serviceStatus = mostSevereServiceStatus(statuses);
      }
    } catch {
      serviceStatus = null;
    }
    return {
      id: contract.id,
      plan: contract.plan,
      status: contract.status,
      technology: contract.technology,
      address: contract.address,
      serviceStatus,
    };
  }

  private async safeInvoices(
    clientId: string,
  ): Promise<{ lastInvoice: InboxInvoiceSummaryDto | null; nextDueDate: string | null }> {
    try {
      const invoices = await this.getInvoices.execute(clientId);
      if (invoices.length === 0) return { lastInvoice: null, nextDueDate: null };

      const sortedByIssueDateDesc = [...invoices].sort((a, b) => (a.issueDate < b.issueDate ? 1 : -1));
      const last = sortedByIssueDateDesc[0];
      const lastInvoice: InboxInvoiceSummaryDto = {
        id: last.id,
        number: last.number,
        dueDate: last.dueDate,
        amount: last.amount,
        status: last.status,
        balance: last.balance,
      };

      const nextPending = invoices
        .filter((i) => i.status === 'pendiente')
        .sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))[0];

      return { lastInvoice, nextDueDate: nextPending?.dueDate ?? null };
    } catch {
      return { lastInvoice: null, nextDueDate: null };
    }
  }

  private async safeLogs(clientId: string): Promise<InboxLogSummaryDto[]> {
    try {
      const result = await this.getLogs.execute({ clientId, page: 1, limit: 5 });
      return result.data.map((l) => ({
        id: l.id,
        timestamp: l.timestamp,
        eventType: l.eventType,
        description: l.description,
      }));
    } catch {
      return [];
    }
  }

  /**
   * states-be (F1.5 spec #2) — ONE fetch (no server-side status filter or
   * count-only port method exists for tasks), split client-side by
   * `generalStatus`. "Closed" for a task = `generalStatus !== 'open'` (groups
   * `closed` + `dismissed`) — NEVER the legacy `isClosed` flag (misleading: a
   * `dismissed` task has `isClosed === false`).
   *
   * PRE-EXISTING DEBT (already flagged at #7b): `ListTasks`/`SchedulingRepository`
   * has no limit/pagination, so this brings back ALL of a client's tasks — not
   * worsened here (the counts below are exact precisely BECAUSE the list isn't
   * truncated), but a real port-level count method would be cheaper at scale.
   */
  private async safeTasks(clientId: string): Promise<{
    recentTasks: InboxTaskSummaryDto[];
    openTasksCount: number;
    recentClosedTasks: InboxTaskSummaryDto[];
    closedTasksCount: number;
  }> {
    try {
      const tasks = await this.listTasks.execute({ customerId: clientId });
      const openTasks = tasks.filter((t) => t.generalStatus === 'open');
      const closedTasks = tasks.filter((t) => t.generalStatus !== 'open');
      const toDto = (t: (typeof tasks)[number]): InboxTaskSummaryDto => ({
        id: t.id,
        sequenceNumber: t.sequenceNumber,
        title: t.title,
        status: t.generalStatus,
      });
      return {
        recentTasks: openTasks.slice(0, 3).map(toDto),
        openTasksCount: openTasks.length,
        recentClosedTasks: closedTasks.slice(0, 2).map(toDto),
        closedTasksCount: closedTasks.length,
      };
    } catch {
      return { recentTasks: [], openTasksCount: 0, recentClosedTasks: [], closedTasksCount: 0 };
    }
  }

  private async safeTickets(clientId: string): Promise<{
    recentTickets: InboxTicketSummaryDto[];
    openTicketsCount: number;
    recentClosedTickets: InboxTicketSummaryDto[];
    closedTicketsCount: number;
  }> {
    // fix-be #5 (+ states-be, F1.5 spec #2) — INDEPENDENT try/catch per sub-query:
    // a failure in ANY ONE of the four (open list, open count, closed list, closed
    // count) must not wipe out the other three. Still fanned out via Promise.all
    // (RICH-2, no serialization).
    const [recentTickets, openTicketsCount, recentClosedTickets, closedTicketsCount] = await Promise.all([
      this.safeRecentTickets(clientId),
      this.safeOpenTicketsCount(clientId),
      this.safeRecentClosedTickets(clientId),
      this.safeClosedTicketsCount(clientId),
    ]);
    return { recentTickets, openTicketsCount, recentClosedTickets, closedTicketsCount };
  }

  private async safeRecentTickets(clientId: string): Promise<InboxTicketSummaryDto[]> {
    try {
      // fix-be #2 — `openOnly: true` filters server-side (resolvedAt/archivedAt
      // null) instead of paginating "any status" and filtering client-side: with
      // ≥25 recently-touched CLOSED tickets, the old client-side filter over a
      // single page-1/limit-25 fetch could come back completely empty even when
      // `openTicketsCount` (via countOpenByClientIds, unaffected) was > 0.
      const listResult = await this.listTickets.execute({ customerId: clientId, openOnly: true });
      return listResult.data.slice(0, 3).map((t) => ({
        id: t.id,
        sequenceNumber: t.sequenceNumber,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
      }));
    } catch {
      return [];
    }
  }

  private async safeOpenTicketsCount(clientId: string): Promise<number> {
    try {
      const openMap = await this.ticketRepo.countOpenByClientIds([clientId]);
      return openMap.get(clientId) ?? 0;
    } catch {
      return 0;
    }
  }

  private async safeRecentClosedTickets(clientId: string): Promise<InboxTicketSummaryDto[]> {
    try {
      // states-be (F1.5 spec #2) — `closedOnly: true` mirrors `openOnly`'s
      // server-side filter (resolvedAt NOT null AND archivedAt null). "Closed" is
      // defined by `Ticket.resolvedAt`, NEVER inferred from `TicketStatusCatalog`
      // (which carries no closed flag).
      const listResult = await this.listTickets.execute({ customerId: clientId, closedOnly: true });
      return listResult.data.slice(0, 2).map((t) => ({
        id: t.id,
        sequenceNumber: t.sequenceNumber,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
      }));
    } catch {
      return [];
    }
  }

  private async safeClosedTicketsCount(clientId: string): Promise<number> {
    try {
      const closedMap = await this.ticketRepo.countClosedByClientIds([clientId]);
      return closedMap.get(clientId) ?? 0;
    } catch {
      return 0;
    }
  }
}
