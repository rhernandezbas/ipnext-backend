import { executionDurationMinutes, relevantCycle, type SoStatusEvent } from '@domain/services/workWindow';
import type { AuditIClassReader } from './AuditServiceOrderPresence';
import type { SoStatusHistoryEntry } from '@domain/entities/iclass-closed-order';

/**
 * Pre-filtro BARATO: órdenes cuya ejecución en campo duró menos de lo físicamente posible.
 *
 * No toca GPS. Se calcula sólo con el histórico de estados, y por eso es órdenes de
 * magnitud más barato que el cruce contra el rastro. Sirve para PRIORIZAR qué auditar.
 *
 * Caso que lo motiva (real): la OS 4995 registró `DESLOCAMENTO 23:29:02` →
 * `ANDAMENTO 23:29:13` → `FECHADA 23:31:18`. Viaje de 11 segundos y visita de 2 minutos.
 * No existe viaje de 11 segundos.
 *
 * **Marca CANDIDATOS a revisar, jamás incumplimientos.** Una ejecución corta puede tener
 * explicación legítima (el técnico ya estaba en el lugar por otra orden, el cliente
 * canceló en la puerta). El veredicto lo da la auditoría GPS, y ni siquiera ésa imputa
 * intención.
 */

/** Por debajo de esto, la ejecución no es físicamente plausible. */
const DEFAULT_THRESHOLD_MINUTES = 5;

export interface SuspiciousClosure {
  serviceOrderCode: string;
  iclassId: string;
  executionMinutes: number;
  teamLogin: string | null;
  teamTechnicianName: string | null;
  /**
   * NO se exponen `customerName` ni `addressLine` (hallazgo 3.5). Este listado es un
   * pre-filtro de órdenes a revisar, no un export del padrón de clientes.
   */
  resultCodeName: string | null;
  soTypeDescription: string | null;
  /** Siempre true: el contrato de esta lista es "revisar", no "sancionar". */
  isCandidateForReview: true;
}

export interface ListSuspiciousClosuresDeps {
  iclass: AuditIClassReader;
  thresholdMinutes?: number;
}

export class ListSuspiciousClosures {
  private readonly iclass: AuditIClassReader;
  private readonly thresholdMinutes: number;

  constructor(deps: ListSuspiciousClosuresDeps) {
    this.iclass = deps.iclass;
    this.thresholdMinutes = deps.thresholdMinutes ?? DEFAULT_THRESHOLD_MINUTES;
  }

  /**
   * @param input.thresholdMinutes umbral POR LLAMADA. Antes la ruta lo validaba y lo
   *        descartaba: un auditor pedía 30, recibía 200 y concluía que no había más
   *        casos, sobre resultados calculados con 5 (hallazgo 3.6).
   */
  async execute(input: {
    from: Date;
    to: Date;
    thresholdMinutes?: number;
  }): Promise<{ candidates: SuspiciousClosure[]; thresholdMinutes: number }> {
    const range = { from: input.from, to: input.to };
    const threshold =
      input.thresholdMinutes !== undefined && Number.isFinite(input.thresholdMinutes) && input.thresholdMinutes > 0
        ? input.thresholdMinutes
        : this.thresholdMinutes;

    const orders = await this.iclass.listServiceOrders({
      updatedDateBegin: range.from,
      updatedDateEnd: range.to,
    });

    const found: SuspiciousClosure[] = [];

    for (const order of orders) {
      let history: SoStatusHistoryEntry[];
      try {
        history = await this.iclass.getServiceOrderHistory(order.iclassId);
      } catch {
        // Una orden cuyo histórico falla no puede tumbar el barrido entero.
        continue;
      }

      const events: SoStatusEvent[] = history
        .filter((h): h is SoStatusHistoryEntry & { occurredAt: string } => !!h.occurredAt)
        .map((h) => ({
          at: new Date(h.occurredAt),
          status: h.statusDescription,
          // R3: la cuadrilla de CADA evento. Sin esto la lista reportaba la cuadrilla
          // ASIGNADA HOY, no la que ejecutó — y ésta es la lista que un supervisor lee
          // PRIMERO, antes que el veredicto GPS. La OS 4995 ya diverge en producción.
          teamLogin: h.teamLogin,
        }))
        // R4: un `occurredAt` ilegible producía `executionMinutes: NaN`, y como
        // `NaN >= threshold` es false, el candidato pasaba el filtro y aparecía en la
        // lista CON NOMBRE Y APELLIDO. El otro use case ya tenía este guard; éste no.
        .filter((e) => Number.isFinite(e.at.getTime()));

      const minutes = executionDurationMinutes(events);
      // `null` = nunca se ejecutó → no hay nada que medir, no es sospechosa.
      if (minutes === null || !Number.isFinite(minutes) || minutes >= threshold) continue;

      // La cuadrilla que EJECUTÓ el ciclo medido, con fallback a la asignada.
      const cycle = relevantCycle(events);
      const executedBy = cycle?.teamLogin ?? order.teamLogin;

      found.push({
        serviceOrderCode: order.iclassCodigo,
        iclassId: order.iclassId,
        executionMinutes: minutes,
        teamLogin: executedBy,
        teamTechnicianName: executedBy === order.teamLogin ? order.teamTechnicianName : null,
        resultCodeName: order.resultCodeName,
        soTypeDescription: order.soTypeDescription,
        isCandidateForReview: true,
      });
    }

    // La más corta primero: es la que menos se explica.
    return {
      candidates: found.sort((a, b) => a.executionMinutes - b.executionMinutes),
      thresholdMinutes: threshold,
    };
  }
}
