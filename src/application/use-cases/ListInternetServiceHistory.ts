import type {
  ContractServiceEventRepository,
} from '@domain/ports/ContractServiceEventRepository';
import type { ServiceCatalogRepository } from '@domain/ports/ServiceCatalogRepository';
import type { PlanRepository } from '@domain/ports/PlanRepository';
import { isEnforcementPlan } from '@domain/entities/plan';
import type { InternetServiceEventDto } from '@application/dto/pppoe.dto';

export type PlanChangeDirection = 'upgrade' | 'downgrade';

export interface ListInternetServiceHistoryFilter {
  actorId?: string;
  /** customerId maps to clientId in the domain. */
  customerId?: string;
  clientId?: string;
  /** internet-history-plan-direction — TÓPICO (eventType) filter, push-down al port (SQL). */
  eventType?: string;
  /**
   * internet-history-plan-direction — filtro por DIRECCIÓN del cambio de plan. INDEPENDIENTE de
   * `eventType`: se aplica in-memory tras derivar la dirección de cada evento. Los eventos que no
   * son cambios de plan (dirección null) NUNCA matchean, así que setearlo implica solo cambios reales.
   */
  direction?: PlanChangeDirection;
  from?: Date;
  to?: Date;
}

/**
 * ListInternetServiceHistory (internet-history) — query use case for the GLOBAL internet
 * service activation/baja log. Mirror of ListTvActivationHistory for the Internet page.
 *
 * INTERNET is identified by ServiceCatalog.name === 'INTERNET'. The use case resolves the
 * catalog id once and passes it as the serviceCatalogId filter, so the result NEVER includes
 * TV nor any other service event. If the INTERNET catalog entry is missing, returns [] (no
 * events leak — failing closed is safer than returning the whole event log).
 *
 * internet-history-plan-direction — the DIRECTION (upgrade/downgrade) of a plan change is NOT
 * persisted; it is DERIVED here by loading the plan catalog once (code → downloadKbps) and
 * comparing newPlan vs oldPlan. Enforcement plans (IP-REDUCCION / IP-BAJA), missing catalog
 * codes, equal kbps and non-'modified' events all derive to `null` (see deriveDirection).
 *
 * Results are always newest-first; mapping to DTO happens here (no domain objects leak out).
 */
export class ListInternetServiceHistory {
  constructor(
    private readonly eventRepo: ContractServiceEventRepository,
    private readonly catalogRepo: ServiceCatalogRepository,
    private readonly planRepo: PlanRepository,
  ) {}

  async execute(filters: ListInternetServiceHistoryFilter): Promise<InternetServiceEventDto[]> {
    const internet = await this.catalogRepo.getByName('INTERNET');
    if (!internet) return [];

    // internet-history-plan-direction — catálogo de planes cargado UNA vez: code → downloadKbps.
    const plans = await this.planRepo.list();
    const kbpsByCode = new Map<string, number>(plans.map(p => [p.code, p.downloadKbps]));

    const events = await this.eventRepo.list({
      serviceCatalogId: internet.id,
      actorId:  filters.actorId,
      clientId: filters.clientId ?? filters.customerId,
      eventType: filters.eventType, // push-down del TÓPICO al port (SQL).
      from:     filters.from,
      to:       filters.to,
    });

    let dtos = events.map(e => toDto(e, kbpsByCode));
    // Filtro por DIRECCIÓN in-memory (tras derivar). Los no-cambios-de-plan tienen direction null.
    if (filters.direction) {
      dtos = dtos.filter(d => d.direction === filters.direction);
    }
    return dtos;
  }
}

/**
 * internet-history-plan-direction — deriva la dirección del cambio de plan comparando el
 * downloadKbps del plan nuevo vs el viejo contra el catálogo. Devuelve `null` (no hay dirección)
 * cuando: el evento NO es 'modified', falta alguno de los códigos, alguno es plan de ENFORCEMENT
 * (IP-REDUCCION / IP-BAJA — corte/reducción, no un cambio comercial), algún código no está en el
 * catálogo, o los kbps son iguales (cambio lateral).
 *
 * finance-growth Fase 3 (design.md — "la dirección upgrade/downgrade se DERIVA del catálogo Plan
 * ... reusar ese criterio, no inventar otro") — EXPORTADA para que
 * `BuildFinanceMonthlySnapshot` (bridge de MRR) use EXACTAMENTE este mismo criterio en vez de
 * reimplementar una segunda comparación de planes que podría divergir de esta página.
 */
export function deriveDirection(
  eventType: string,
  oldPlan: string | null,
  newPlan: string | null,
  kbpsByCode: Map<string, number>,
): PlanChangeDirection | null {
  if (eventType !== 'modified') return null;
  if (!oldPlan || !newPlan) return null;
  if (isEnforcementPlan(oldPlan) || isEnforcementPlan(newPlan)) return null;
  const oldKbps = kbpsByCode.get(oldPlan);
  const newKbps = kbpsByCode.get(newPlan);
  if (oldKbps === undefined || newKbps === undefined) return null; // código fuera del catálogo
  if (newKbps > oldKbps) return 'upgrade';
  if (newKbps < oldKbps) return 'downgrade';
  return null; // kbps iguales → cambio lateral, sin dirección
}

function toDto(
  e: {
    id: string;
    contractId: string;
    clientId: string | null;
    customerName: string | null;
    serviceCatalogId: string;
    eventType: string;
    actorId: string | null;
    actorName: string;
    oldPlan: string | null;
    newPlan: string | null;
    // pppoe-change-audit — cambios de IP/password/status.
    changeKind: string | null;
    oldValue: string | null;
    newValue: string | null;
    reason: string | null;
    createdAt: string;
  },
  kbpsByCode: Map<string, number>,
): InternetServiceEventDto {
  return {
    id:               e.id,
    contractId:       e.contractId,
    clientId:         e.clientId,
    customerName:     e.customerName,
    serviceCatalogId: e.serviceCatalogId,
    eventType:        e.eventType,
    actorId:          e.actorId,
    actorName:        e.actorName,
    reason:           e.reason ?? null,
    direction:        deriveDirection(e.eventType, e.oldPlan ?? null, e.newPlan ?? null, kbpsByCode),
    oldPlan:          e.oldPlan ?? null,
    newPlan:          e.newPlan ?? null,
    // pppoe-change-audit — passthrough al wire; null en eventos de plan/activación.
    changeKind:       e.changeKind ?? null,
    oldValue:         e.oldValue ?? null,
    newValue:         e.newValue ?? null,
    createdAt:        e.createdAt,
  };
}
