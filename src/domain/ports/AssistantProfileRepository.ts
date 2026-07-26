import type { AssistantIntent, AssistantProfile } from '@domain/entities/assistant';

/**
 * ai-assistant-multiagent (CFG-1/CFG-2) — persistencia de la configuración de agentes.
 *
 * Un perfil por área (`areaId` es UNIQUE) y N intenciones por perfil. Como
 * `TicketAreaCatalog` YA es compartido por `Ticket.areaId` y `Conversation.areaId`, un
 * perfil sirve a las DOS superficies sin duplicar nada.
 */

/** Alta de perfil. `enabled` NO se acepta acá: CFG-1 exige que nazca apagado. */
export interface CreateAssistantProfileInput {
  areaId: string;
  persona?: string;
  handoffMessage?: string;
  model?: string;
  classifierModel?: string | null;
  timeoutMs?: number;
}

/**
 * Patch parcial: `undefined` = no tocar. `enabledActions` se reemplaza COMPLETO cuando
 * viene (no hay merge de arrays — el editor de la UI manda el set entero).
 */
export interface UpdateAssistantProfileInput {
  enabled?: boolean;
  persona?: string;
  handoffMessage?: string;
  model?: string;
  classifierModel?: string | null;
  timeoutMs?: number;
  enabledActions?: string[];
}

export interface CreateAssistantIntentInput {
  profileId: string;
  name: string;
  description: string;
  examples?: string[];
  enabled?: boolean;
  dataSourceKeys?: string[];
  responseGuide?: string;
  actionKey: string;
}

export interface UpdateAssistantIntentInput {
  name?: string;
  description?: string;
  examples?: string[];
  enabled?: boolean;
  dataSourceKeys?: string[];
  responseGuide?: string;
  actionKey?: string;
}

export interface AssistantProfileRepository {
  /**
   * Perfil del área, o `null` si no existe. El motor trata "no existe" y "existe pero
   * `enabled:false`" IGUAL: handoff (RTR-3). Nunca lanza por ausencia.
   */
  findByAreaId(areaId: string): Promise<AssistantProfile | null>;
  findById(id: string): Promise<AssistantProfile | null>;
  list(): Promise<AssistantProfile[]>;
  /** CFG-1 — el perfil resultante MUST tener `enabled === false`. */
  create(input: CreateAssistantProfileInput): Promise<AssistantProfile>;
  /** `null` si el perfil no existe (el caller decide si es 404). */
  update(id: string, input: UpdateAssistantProfileInput): Promise<AssistantProfile | null>;
  delete(id: string): Promise<boolean>;
}

export interface AssistantIntentRepository {
  /**
   * TODAS las intenciones del perfil (habilitadas y no). El filtro por `enabled` es del
   * motor, no del repo: la UI necesita ver las apagadas para poder prenderlas.
   */
  listByProfileId(profileId: string): Promise<AssistantIntent[]>;
  /**
   * RTR-2 — SÓLO las habilitadas. Este es el universo de candidatas del clasificador:
   * jamás un vocabulario global ni intenciones de otro perfil.
   */
  listEnabledByProfileId(profileId: string): Promise<AssistantIntent[]>;
  findById(id: string): Promise<AssistantIntent | null>;
  /** `@@unique([profileId, name])`: un nombre repetido en el MISMO perfil es un conflicto. */
  create(input: CreateAssistantIntentInput): Promise<AssistantIntent>;
  update(id: string, input: UpdateAssistantIntentInput): Promise<AssistantIntent | null>;
  delete(id: string): Promise<boolean>;
}
