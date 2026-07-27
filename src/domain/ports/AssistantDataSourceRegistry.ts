/**
 * ai-assistant-multiagent (CFG-3 / SEC-1, design D2) — registro de fuentes de datos.
 *
 * Cada `key` del catálogo `AssistantDataSource` tiene acá su implementación. El registro vive
 * en CÓDIGO y no en la base: agregar una fuente nueva requiere escribir un resolver y pasar
 * por review, porque cada fuente es una puerta a la base de datos. Desde la UI sólo se
 * HABILITA lo que ya existe (frontera R5 del proposal).
 */

/**
 * Lo que un resolver recibe para consultar.
 *
 * ⚠️ **SEC-1 GARANTIZADO POR EL TIPO.** Esta interfaz NO declara —y nunca debe declarar—
 * ningún campo de identidad: nada de `name`, `email`, `phone`, `documento`, `direccion`.
 * `clientId` es un identificador OPACO que el resolver usa para consultar del lado local; no
 * viaja al modelo y no dice nada de quién es la persona.
 *
 * Si alguien necesita el nombre del cliente para armar un hecho, la respuesta es que NO lo
 * necesita: la personalización se hace por plantilla en post-proceso, del lado de acá.
 */
export interface AssistantSubjectContext {
  /** Opaco. `null` cuando el teléfono no matcheó ningún cliente (conversación anónima). */
  clientId: string | null;
  conversationId: string;
  areaId: string;
}

/**
 * Un resolver devuelve HECHOS planos y ya interpretados — nunca filas crudas.
 *
 * Devolver `{}` es válido y significa "no hay nada que aportar para este cliente". Un
 * resolver NO debe lanzar por ausencia de datos; sí puede lanzar ante un fallo real de
 * infraestructura, y el ensamblador lo aísla (un resolver caído no tumba el resto).
 */
export interface AssistantDataSourceResolver {
  /** Debe coincidir con una `key` del catálogo `AssistantDataSource`. */
  readonly key: string;
  resolve(ctx: AssistantSubjectContext): Promise<Record<string, unknown>>;
}

export interface AssistantDataSourceRegistry {
  /** `null` si la key no tiene implementación registrada (config vieja, resolver removido). */
  get(key: string): AssistantDataSourceResolver | null;
  /** Keys con implementación — usado por el arranque para validar contra el catálogo. */
  keys(): string[];
}
