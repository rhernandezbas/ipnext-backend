/**
 * ai-assistant-multiagent — entidades del asistente IA configurable por área.
 * Ver `openspec/changes/ai-assistant-multiagent/`.
 *
 * PRINCIPIO RECTOR (proposal D6): la CONFIGURACIÓN es 100% editable en runtime; sólo las
 * CAPACIDADES nuevas (una fuente de datos o una acción que hoy no existe) requieren código.
 * Por eso `AssistantIntent` es una FILA y no un enum: agregar comportamiento es cargar
 * datos desde la UI, sin deploy.
 */

/**
 * Nivel de riesgo de una acción (proposal §7). Determina el orden de encendido y el gate
 * de EVAL-2: las `red` no se habilitan sin una corrida de eval registrada.
 * - `green`  — lo ve un EMPLEADO (comment_internal, suggest_area). Daño ~0.
 * - `yellow` — lo ve el CLIENTE (whatsapp_reply, comment_public).
 * - `red`    — entierra un problema o cuesta plata (close_ticket, create_task).
 */
export type AssistantRiskLevel = 'green' | 'yellow' | 'red';

/**
 * Superficie sobre la que opera el motor.
 *
 * v1 = SÓLO conversaciones de Chatwoot (aclaración del usuario 2026-07-26: los tickets
 * quedaron fuera de alcance; el pedido original era sobre conversaciones). Se mantiene
 * como unión de un miembro —y no se borra la columna— porque la tabla de auditoría gana en
 * ser explícita sobre QUÉ auditó, y ampliar una unión después es trivial.
 */
export type AssistantSubjectType = 'conversation';

/**
 * Resultado de una invocación del motor (OBS-1).
 * - `replied`          — el agente actuó (respondió/comentó/reclasificó).
 * - `handoff`          — no actuó a propósito; queda para el humano.
 * - `noop`             — no corrió (flag global OFF, perfil ausente/apagado, anti-loop).
 * - `rejected_numbers` — SEC-4 descartó la salida: el modelo escribió una cifra que NO
 *                        estaba en los hechos inyectados. Es la métrica de alucinación
 *                        atajada — se mira aparte porque es la señal más valiosa del sistema.
 * - `error`            — falla interna ya degradada a no-op (RUN-1 nunca propaga).
 */
export type AssistantOutcome = 'replied' | 'handoff' | 'noop' | 'rejected_numbers' | 'error';

/**
 * CFG-1 — configuración del agente de UN área. `enabled` nace en `false`: un perfil recién
 * creado NUNCA habla hasta que alguien lo habilite explícitamente. La ausencia de
 * configuración SIEMPRE resuelve a "no hablar", nunca a "improvisar" (RTR-3).
 */
export interface AssistantProfile {
  id: string;
  areaId: string;
  enabled: boolean;
  persona: string;
  handoffMessage: string;
  /** Modelo de REDACCIÓN (paso 4 del pipeline, design D1). */
  model: string;
  /** Modelo del CLASIFICADOR (paso 1). `null` ⇒ usa `model`. */
  classifierModel: string | null;
  timeoutMs: number;
  /**
   * Keys de `AssistantAction` habilitadas para ESTE perfil (ACT-1). Una acción que no
   * figure acá resuelve a handoff AUNQUE una intención la referencie — el chequeo es por
   * invocación, no al boot.
   */
  enabledActions: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * CFG-2 — una intención = una FILA. `description` y `examples[]` son el material que lee el
 * clasificador (RTR-2): el universo de candidatas es SIEMPRE el de las intents `enabled` DEL
 * PERFIL DEL ÁREA — nunca un vocabulario global ni las de otro perfil.
 */
export interface AssistantIntent {
  id: string;
  profileId: string;
  name: string;
  description: string;
  examples: string[];
  enabled: boolean;
  /**
   * Qué datos ve esta intención. Cada key MUST existir en el catálogo (CFG-3, validado con
   * 400 en configuración). El motor resuelve SÓLO estas fuentes — no "todo lo que haya".
   */
  dataSourceKeys: string[];
  responseGuide: string;
  /** MUST existir en el catálogo de acciones Y estar en `profile.enabledActions` (ACT-1). */
  actionKey: string;
  /**
   * ai-assistant-cobranzas (D2) — labels de Chatwoot que `executeAction('handoff')` aplica
   * junto a `ASSISTANT_LABEL_NEEDS_HUMAN`. `String[]` porque un label de Chatwoot es una
   * string de un sistema externo: no hay integridad referencial posible desde acá (ADR 0003
   * exige catálogo editable en runtime, no un enum ni una tabla `AssistantLabel` con FK sobre
   * un vocabulario cuya autoridad vive en Chatwoot).
   */
  labels: string[];
  /**
   * ai-assistant-cobranzas (D5) — pre-chequeo determinístico (`matchTriggerIntent`, RTR-4):
   * corre ANTES de `runtime.classify`, así que cobrarle a un cliente sin servicio no depende
   * de que el clasificador acierte. Sólo debería tener contenido en intents con
   * `actionKey:'handoff'` — la validación de esa regla (400 si no) vive en la capa de
   * configuración (CFG-2 modificado), no en esta entidad.
   */
  triggerPatterns: string[];
  /**
   * ai-assistant-cobranzas (D10) — desasignar la conversación DESPUÉS de ejecutar la acción
   * (`whatsapp_reply`, `private_note` o `handoff`), en los DOS lados donde vive la asignación
   * (`AssistantConversationGateway.unassign`, ACT-4). Booleano por fila: el motor MUST NOT
   * derivar el desasignado del NOMBRE de un label — `soporte` no debe desasignar aunque
   * `administracion` sí.
   */
  unassign: boolean;
  /**
   * ai-assistant-cobranzas (D11) — rol estable para los selectores determinísticos
   * (`selectComprobanteOutcome`): el operador puede renombrar `name` desde la UI sin romper
   * la referencia. `null` ⇒ la intent no participa de ningún selector. MUST ser único POR
   * PERFIL (validado con 400 en la ruta de config, no acá).
   */
  roleKey: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * CFG-3 — entrada del catálogo de FUENTES. La implementación de cada `key` vive en código
 * (`AssistantDataSourceRegistry`, design D2). Esta entidad sólo modela habilitación: NO
 * existe camino para CREAR una fuente desde la UI, porque cada fuente es una puerta a la
 * base y definirlas por formulario sería una inyección con formulario bonito.
 */
export interface AssistantDataSourceEntry {
  key: string;
  label: string;
  enabled: boolean;
  updatedAt: string;
}

/** CFG-3 — entrada del catálogo de ACCIONES. Misma frontera que las fuentes. */
export interface AssistantActionEntry {
  key: string;
  label: string;
  riskLevel: AssistantRiskLevel;
  updatedAt: string;
}

/**
 * OBS-1 — auditoría de CADA invocación del motor, responda o no. MUST NOT contener PII ni el
 * prompt crudo: sólo qué agente actuó, con qué intención, qué fuentes resolvió y en qué
 * terminó. Es la fuente de verdad para depurar por qué el bot dijo (o calló) algo.
 */
export interface AssistantRun {
  id: string;
  profileId: string | null;
  areaId: string | null;
  subjectType: AssistantSubjectType;
  subjectId: string;
  /** `null` ⇒ el clasificador no matcheó ninguna intención habilitada (default deny). */
  intentName: string | null;
  dataSources: string[];
  actionKey: string | null;
  outcome: AssistantOutcome;
  reason: string | null;
  latencyMs: number | null;
  createdAt: string;
}
