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
