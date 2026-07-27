import type { ClosedServiceOrderSummary, SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';
import type { TeamLocationRepository } from '@domain/ports/TeamLocationRepository';
import {
  evaluatePresence,
  PRESENCE_DEFAULTS,
  type PresenceEvaluation,
} from '@domain/services/presenceEvaluation';
import { computeWorkWindow, relevantCycle, type SoStatusEvent } from '@domain/services/workWindow';

/**
 * Responde, para UNA orden de servicio: ¿el técnico estuvo en el domicilio durante la
 * ventana REAL de trabajo?
 *
 * Produce EVIDENCIA, no acusaciones. Toda la lógica de honestidad vive en
 * `evaluatePresence` (dominio puro); este caso de uso sólo reúne los insumos:
 * la orden, su histórico de estados y el rastro persistido de la cuadrilla.
 */

/** Ventana de búsqueda de la OS en IClass. La API tope es de 30 días. */
const DEFAULT_LOOKUP_DAYS = 29;

/** Sólo lo que este caso de uso necesita del port de IClass (nada de escritura). */
export interface AuditIClassReader {
  listServiceOrders(params: {
    updatedDateBegin: Date;
    updatedDateEnd: Date;
    serviceOrderCode?: string;
  }): Promise<ClosedServiceOrderSummary[]>;
  getServiceOrderHistory(iclassId: string): Promise<SoStatusHistoryEntry[]>;
}

export interface AuditServiceOrderPresenceDeps {
  iclass: AuditIClassReader;
  repo: TeamLocationRepository;
  now?: () => Date;
  onSiteThresholdMeters?: number;
  windowMarginMinutes?: number;
  lookupDays?: number;
}

export interface ServiceOrderPresenceReport extends PresenceEvaluation {
  serviceOrderCode: string;
  teamLogin: string | null;
  teamTechnicianName: string | null;
  /**
   * NO se exponen `customerName` ni `addressLine` (hallazgo 3.5): alguien con
   * `technicians.location_audit` y SIN `clients.read` se llevaba un export masivo del
   * padrón de clientes por la puerta lateral. Para responder "¿estuvo o no estuvo?"
   * alcanzan las coordenadas, que ya se usan internamente. Los datos del cliente se
   * piden al módulo `clients`, con su propio permiso.
   */
  resultCodeName: string | null;
  /**
   * `coordenadasFechamento` de IClass. Medido 2026-07-26: viene VACÍO en 0 de 416 OS.
   * Se reporta como ausente — jamás se infiere ni se deriva de otro dato.
   */
  closureCoordinates: { latitude: number; longitude: number; at: string | null } | null;
}

const NOT_AUDITABLE = (
  serviceOrderCode: string,
  reason: string,
  threshold: number,
): ServiceOrderPresenceReport => ({
  verdict: 'NO_AUDITABLE',
  reason,
  minDistanceMeters: null,
  closestPointAt: null,
  closestAccuracyMeters: null,
  pointsEvaluated: 0,
  largestCoverageGapMinutes: null,
  window: null,
  mapsUrl: null,
  onSiteThresholdMeters: threshold,
  serviceOrderCode,
  teamLogin: null,
  teamTechnicianName: null,
  resultCodeName: null,
  closureCoordinates: null,
});

export class AuditServiceOrderPresence {
  private readonly iclass: AuditIClassReader;
  private readonly repo: TeamLocationRepository;
  private readonly now: () => Date;
  private readonly onSiteThresholdMeters: number;
  private readonly windowMarginMinutes: number;
  private readonly lookupDays: number;

  constructor(deps: AuditServiceOrderPresenceDeps) {
    this.iclass = deps.iclass;
    this.repo = deps.repo;
    this.now = deps.now ?? (() => new Date());
    this.onSiteThresholdMeters = deps.onSiteThresholdMeters ?? PRESENCE_DEFAULTS.onSiteThresholdMeters;
    this.windowMarginMinutes = deps.windowMarginMinutes ?? PRESENCE_DEFAULTS.windowMarginMinutes;
    this.lookupDays = deps.lookupDays ?? DEFAULT_LOOKUP_DAYS;
  }

  async execute(input: { serviceOrderCode: string }): Promise<ServiceOrderPresenceReport> {
    const { serviceOrderCode } = input;
    const now = this.now();

    const orders = await this.iclass.listServiceOrders({
      updatedDateBegin: new Date(now.getTime() - this.lookupDays * 24 * 60 * 60 * 1000),
      updatedDateEnd: now,
      serviceOrderCode,
    });
    // GUARD DE MATCH EXACTO (hallazgo 1.6). El filtro `serviceOrderCode` de IClass puede
    // comportarse como prefijo/LIKE — el propio `IClassClient.getServiceOrder` documenta
    // y aplica este guard (`IClassClient.ts:433`). Sin él, pedir la OS "499" puede
    // devolver la "4995": se auditaría otro domicilio, otra cuadrilla y otra ventana,
    // reportado bajo el código que se pidió.
    const order = orders.find((o) => String(o.iclassCodigo) === String(serviceOrderCode));
    if (!order) {
      return NOT_AUDITABLE(
        serviceOrderCode,
        `No se encontró la orden ${serviceOrderCode} en IClass dentro de los últimos ` +
          `${this.lookupDays} días (la API no permite buscar más atrás).`,
        this.onSiteThresholdMeters,
      );
    }

    const history = await this.iclass.getServiceOrderHistory(order.iclassId);
    const events: SoStatusEvent[] = history
      .filter((h): h is SoStatusHistoryEntry & { occurredAt: string } => !!h.occurredAt)
      .map((h) => ({
        at: new Date(h.occurredAt),
        status: h.statusDescription,
        // La cuadrilla de CADA evento: la orden puede reasignarse y auditar el rastro de
        // la cuadrilla equivocada acusa a alguien que ni tenía la orden (hallazgo 1.3).
        teamLogin: h.teamLogin,
      }))
      .filter((e) => Number.isFinite(e.at.getTime()));

    const window = computeWorkWindow(events, { marginMinutes: this.windowMarginMinutes });
    const cycle = relevantCycle(events);

    // La cuadrilla que EJECUTÓ el ciclo auditado, con fallback a la asignada hoy sólo si
    // el histórico no la informa.
    const auditedTeam = cycle?.teamLogin ?? order.teamLogin;

    const address =
      order.addressLat !== null && order.addressLng !== null
        ? { latitude: order.addressLat, longitude: order.addressLng }
        : null;

    // El rastro sólo se consulta si hay cuadrilla y ventana: sin eso no hay nada que evaluar.
    const points =
      auditedTeam && window ? await this.repo.findByTeamInWindow(auditedTeam, window) : [];

    const evaluation = evaluatePresence({
      address,
      teamLogin: auditedTeam,
      window,
      points,
      onSiteThresholdMeters: this.onSiteThresholdMeters,
    });

    return {
      ...evaluation,
      serviceOrderCode,
      teamLogin: auditedTeam,
      teamTechnicianName: order.teamTechnicianName,
      resultCodeName: order.resultCodeName,
      closureCoordinates:
        order.closeLatitude !== null && order.closeLongitude !== null
          ? { latitude: order.closeLatitude, longitude: order.closeLongitude, at: order.closeGpsAt }
          : null,
    };
  }
}
