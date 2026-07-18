import { DomainError } from './index';

/**
 * N1 (noc-broadcast) — typed errors. Codes = wire contract; the global errorHandler
 * maps them via statusMap:
 *   NOC_BROADCAST_NOT_CONFIGURED  → 503 (feature apagada/incompleta; molde SMARTOLT_NOT_CONFIGURED)
 *   EVOLUTION_API_ERROR           → 502 (upstream Evolution/Pi falló; molde *_UNAVAILABLE)
 *   NOC_BROADCAST_LINK_BASE_MISSING → 422 (appPublicUrl vacío: no se puede armar el deep link)
 */

/** enabled=false o algún campo Evolution vacío → no se puede enviar. */
export class NocBroadcastNotConfiguredError extends DomainError {
  constructor(
    message = 'La difusión NOC no está configurada (Evolution API incompleta o deshabilitada)',
  ) {
    super(message, 'NOC_BROADCAST_NOT_CONFIGURED');
    this.name = 'NocBroadcastNotConfiguredError';
  }
}

/** Cualquier fallo de transporte contra la instancia Evolution (red/timeout/4xx/5xx). */
export class EvolutionApiError extends DomainError {
  constructor(public readonly detail: string) {
    super(detail, 'EVOLUTION_API_ERROR');
    this.name = 'EvolutionApiError';
  }
}

/**
 * `appPublicUrl` vacío al momento de armar el deep link (BroadcastToNoc). Un link
 * sin host es inútil en WhatsApp, así que se falla fuerte en vez de mandar un
 * link relativo. Separado del `configured` predicate (appPublicUrl es ortogonal).
 */
export class NocBroadcastLinkBaseMissingError extends DomainError {
  constructor(
    message = 'appPublicUrl vacío — configurá la URL pública de la app para armar el deep link',
  ) {
    super(message, 'NOC_BROADCAST_LINK_BASE_MISSING');
    this.name = 'NocBroadcastLinkBaseMissingError';
  }
}

/**
 * N3 (network-task-broadcast) — se intentó difundir al NOC una tarea que NO es de
 * red (kind !== 'network'). Sólo las tareas de RED se difunden al canal NOC. El
 * statusMap lo mapea a 422 (request bien formada, semántica inválida para el recurso).
 */
export class TaskNotBroadcastableError extends DomainError {
  constructor(
    message = 'Solo las tareas de red se difunden al NOC',
  ) {
    super(message, 'TASK_NOT_BROADCASTABLE');
    this.name = 'TaskNotBroadcastableError';
  }
}
