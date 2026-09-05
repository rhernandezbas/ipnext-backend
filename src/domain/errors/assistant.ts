/**
 * ai-assistant-multiagent — errores tipados de la configuración de agentes IA.
 *
 * Mapeo HTTP en `errorHandler.ts` (fuente única de verdad):
 *   ASSISTANT_PROFILE_NOT_FOUND → 404 · ASSISTANT_PROFILE_ALREADY_EXISTS → 409
 *   ASSISTANT_INTENT_NOT_FOUND  → 404 · ASSISTANT_INTENT_NAME_CONFLICT   → 409
 *   UNKNOWN_ASSISTANT_DATA_SOURCE → 400 · UNKNOWN_ASSISTANT_ACTION → 400
 *   ASSISTANT_ACTION_REQUIRES_EVAL → 409 · INVALID_ASSISTANT_EVAL_RUN → 422
 *   ASSISTANT_PII_LEAK → sin mapeo (nunca llega al HTTP: el motor lo atrapa)
 *
 * NOTA: el motor (`ReplyWithAssistant`) NUNCA lanza estos errores — RUN-1 exige que degrade
 * a no-op. Estos son de la capa de CONFIGURACIÓN, donde un input inválido sí debe rebotar
 * fuerte y temprano: es la última barrera antes de que una key inventada quede persistida.
 */
import { DomainError } from './index';

export class AssistantProfileNotFoundError extends DomainError {
  constructor(message = 'Assistant profile not found') {
    super(message, 'ASSISTANT_PROFILE_NOT_FOUND');
    this.name = 'AssistantProfileNotFoundError';
  }
}

/** CFG-1 — un área tiene a lo sumo UN perfil (`areaId` es `@unique`). */
export class AssistantProfileAlreadyExistsError extends DomainError {
  constructor(message = 'This area already has an assistant profile') {
    super(message, 'ASSISTANT_PROFILE_ALREADY_EXISTS');
    this.name = 'AssistantProfileAlreadyExistsError';
  }
}

export class AssistantIntentNotFoundError extends DomainError {
  constructor(message = 'Assistant intent not found') {
    super(message, 'ASSISTANT_INTENT_NOT_FOUND');
    this.name = 'AssistantIntentNotFoundError';
  }
}

/** CFG-2 — `@@unique([profileId, name])`: el mismo nombre en OTRO perfil sí es válido. */
export class AssistantIntentNameConflictError extends DomainError {
  constructor(message = 'An intent with that name already exists in this profile') {
    super(message, 'ASSISTANT_INTENT_NAME_CONFLICT');
    this.name = 'AssistantIntentNameConflictError';
  }
}

/**
 * ai-assistant-cobranzas (D5, CFG-2 modificado) — `triggerPatterns` no vacío en una intent
 * cuyo `actionKey` NO es `handoff`. Sólo las intents de STOP llevan pre-chequeo (RTR-4): un
 * patrón en una intent que sí responde correría ANTES del clasificador y podría secuestrar
 * conversaciones que debían redactarse, no derivarse en seco.
 */
export class TriggerPatternsRequireHandoffActionError extends DomainError {
  constructor(message = "triggerPatterns solo se permite cuando actionKey es 'handoff'") {
    super(message, 'ASSISTANT_TRIGGER_PATTERNS_REQUIRE_HANDOFF');
    this.name = 'TriggerPatternsRequireHandoffActionError';
  }
}

/**
 * ai-assistant-cobranzas (CFG-2 / D11) — dos intents del MISMO perfil con el mismo `roleKey`.
 *
 * El selector determinístico (4b) resuelve la intent de destino POR `roleKey` y se queda con
 * la PRIMERA que encuentra: con dos filas empatadas, cuál gana depende del orden en que la
 * base devolvió las filas — el bot contestaría una cosa u otra según el día. No se arregla
 * con un desempate arbitrario en el runtime, se rechaza al configurar.
 *
 * Sin índice único en la base a propósito (design D11): la unicidad que importa es POR
 * PERFIL, y una constraint global impediría que dos perfiles tengan su propia
 * `comprobante_mp` — además de obligar a un backfill sobre una columna nullable.
 */
export class AssistantRoleKeyConflictError extends DomainError {
  constructor(roleKey: string) {
    super(`ya existe otra intencion con roleKey "${roleKey}" en este perfil`, 'ASSISTANT_ROLE_KEY_CONFLICT');
    this.name = 'AssistantRoleKeyConflictError';
  }
}

/**
 * CFG-3 — una `dataSourceKey` que no existe en el catálogo. Se rechaza en CONFIGURACIÓN,
 * nunca se ejecuta: cada fuente es una puerta a la base, y una key inventada que llegara al
 * runtime sería, en el mejor caso, un silencio raro y en el peor una superficie inesperada.
 */
export class UnknownAssistantDataSourceError extends DomainError {
  public readonly keys: string[];

  constructor(keys: string[]) {
    super(`Unknown assistant data source key(s): ${keys.join(', ')}`, 'UNKNOWN_ASSISTANT_DATA_SOURCE');
    this.name = 'UnknownAssistantDataSourceError';
    this.keys = keys;
  }
}

/** CFG-3 — ídem para `actionKey`. */
export class UnknownAssistantActionError extends DomainError {
  public readonly keys: string[];

  constructor(keys: string[]) {
    super(`Unknown assistant action key(s): ${keys.join(', ')}`, 'UNKNOWN_ASSISTANT_ACTION');
    this.name = 'UnknownAssistantActionError';
    this.keys = keys;
  }
}

/**
 * SEC-1 — se detectó identidad del cliente en los hechos que iban camino al modelo.
 *
 * NO es un error de usuario: es un BUG nuestro (un resolver que filtró un campo). Por eso no
 * tiene mapeo HTTP — el motor lo atrapa, degrada a no-op (RUN-1) y registra
 * `outcome:'error'`. El cliente no recibe nada y el dato no sale del proceso.
 *
 * El mensaje NOMBRA la clave ofensora pero NUNCA incluye el valor: loguear el dato filtrado
 * para avisar que se filtró un dato sería exactamente el mismo problema, en otro archivo.
 */
export class AssistantPiiLeakError extends DomainError {
  public readonly offendingKeys: string[];

  constructor(offendingKeys: string[]) {
    super(
      `Assistant facts contain client identity — blocked before leaving the process: ${offendingKeys.join(', ')}`,
      'ASSISTANT_PII_LEAK',
    );
    this.name = 'AssistantPiiLeakError';
    this.offendingKeys = offendingKeys;
  }
}

/**
 * EVAL-1 — corrida de evaluación inválida. El caso que más importa: `abstentionTotal === 0`.
 * Un eval que sólo mide resolución ignora el modo de falla peligroso (que el bot invente en vez
 * de callarse), y aceptarlo permitiría destrabar acciones de riesgo con un número vacío.
 */
export class InvalidAssistantEvalRunError extends DomainError {
  public readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid assistant eval run: ${problems.join('; ')}`, 'INVALID_ASSISTANT_EVAL_RUN');
    this.name = 'InvalidAssistantEvalRunError';
    this.problems = problems;
  }
}

/**
 * EVAL-2 — habilitar una acción `riskLevel:'red'` (`resolve_conversation`) sin una corrida de
 * eval registrada. Es un candado deliberado: esas acciones se prenden con datos, no con
 * entusiasmo.
 */
export class AssistantActionRequiresEvalError extends DomainError {
  public readonly keys: string[];

  constructor(keys: string[]) {
    super(
      `Enabling high-risk action(s) requires a recorded evaluation run: ${keys.join(', ')}`,
      'ASSISTANT_ACTION_REQUIRES_EVAL',
    );
    this.name = 'AssistantActionRequiresEvalError';
    this.keys = keys;
  }
}

/**
 * RTR-0 — se intentó poner como área default una que NO tiene agente configurado.
 *
 * Rechazar esto es el punto: guardarlo no falla en ningún lado. El motor haría
 * `findByAreaId` → `null` → no-op, en silencio, para SIEMPRE. La pantalla mostraría un ruteo
 * "configurado" y el bot no contestaría nunca. Es más honesto un 400 accionable ahora que un
 * silencio inexplicable después.
 *
 * No distingue "el área no existe" de "existe pero no tiene agente": las dos terminan en el
 * mismo no-op, y el operador hace lo mismo en ambos casos (crear el agente).
 */
export class AssistantDefaultAreaWithoutAgentError extends DomainError {
  public readonly areaId: string;

  constructor(areaId: string) {
    super(
      `El área "${areaId}" no tiene agente configurado, así que no puede ser el área default: ` +
        'el asistente no respondería nada. Creá el agente para esa área primero.',
      'ASSISTANT_DEFAULT_AREA_WITHOUT_AGENT',
    );
    this.name = 'AssistantDefaultAreaWithoutAgentError';
    this.areaId = areaId;
  }
}
