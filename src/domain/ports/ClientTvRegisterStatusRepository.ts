import type { GigaredAccount } from './GigaredPort';

/**
 * ClientTvRegisterStatusRepository (gigared-alta-asincrona W1.2) — estado del job de ALTA de TV.
 *
 * Espejo del molde de `ClientTvCancelStatusRepository`, pero para el alta. Persiste el estado en
 * curso / terminal del job en la DB espejo (tabla Client), en cuatro columnas nullable:
 *   tvRegisterStatus      — 'pending' | 'running' | 'done' | 'failed'
 *   tvRegisterResult      — result de RegisterGigaredAccount en done; {error:string} en failed
 *   tvRegisterStartedAt   — cuándo se ENCOLÓ el job. INMUTABLE mientras el job vive.
 *   tvRegisterHeartbeatAt — última señal de vida (lease). El runner la renueva; el watchdog la mide.
 *
 * El sync de GR NUNCA escribe estas columnas — son estado mirror-only del job asíncrono.
 *
 * ⚠️ DIFERENCIA DELIBERADA con el molde del cancel: acá los sellos se escriben TAMBIÉN en
 * 'pending'. Sin ellos el watchdog (`isTvRegisterJobActive`) no puede acotar la edad de un job
 * huérfano y el cliente queda bloqueado para siempre — que es exactamente el agujero abierto de
 * `CancelTvJobRunner`.
 *
 * ⚠️ Y OTRA: este port NO expone un `setStatus` de overwrite ciego. Las dos únicas escrituras son
 * `tryReserve` (compare-and-set de la reserva) y `compareAndSet` (escritura con fencing). Un
 * overwrite ciego reintroduciría los dos agujeros que este archivo existe para cerrar.
 */

export type TvRegisterStatusValue = 'pending' | 'running' | 'done' | 'failed';

/**
 * Resultado del alta tal como se persiste para el polling del FE.
 *
 * Es estructuralmente el mismo shape que devuelve `RegisterGigaredAccount.execute`, pero declarado
 * ACÁ en el dominio a propósito: el guard `domainLayerPurity` prohíbe que un port importe de
 * `@application/` y su allowlist de deuda preexistente NO puede crecer (el port hermano del cancel
 * es una de las dos entradas de esa lista — es deuda, no un precedente a imitar).
 */
export interface TvRegisterJobResult {
  account: GigaredAccount;
  partnerCreated: boolean;
  localReconciled: 'synced' | 'failed';
  credentialsPersisted: boolean;
  recovered: boolean;
}

/**
 * Fallo del job. El `code` es el del error de DOMINIO (NO_CIC_AVAILABLE, TV_POOL_POISONED,
 * TV_EMAIL_OWNED_BY_OTHER…): cuando el alta era síncrona viajaba por HTTP y el FE ramificaba con
 * él. Se persiste para que volverla asíncrona no degrade eso a un string suelto. Ausente cuando el
 * error no es de dominio (un Error pelado no inventa un code).
 */
export interface TvRegisterJobError {
  error: string;
  code?: string;
}

export interface TvRegisterStatusRow {
  status: TvRegisterStatusValue;
  result?: TvRegisterJobResult | TvRegisterJobError;
  /** Cuándo se ENCOLÓ el alta. INMUTABLE — es lo que el operador ve en el polling. */
  startedAt?: Date;
  /**
   * Última señal de vida del job. Lo re-sella el runner mientras avanza (heartbeat) y es contra
   * ESTE sello que el watchdog decide si el job murió. Ver `isTvRegisterJobActive`.
   */
  heartbeatAt?: Date;
}

export interface ClientTvRegisterStatusRepository {
  /**
   * Lee el estado actual del alta para un cliente.
   * Devuelve null si nunca se encoló un alta para ese cliente.
   */
  getStatus(clientId: string): Promise<TvRegisterStatusRow | null>;

  /**
   * RESERVA ATÓMICA del alta (compare-and-set). Devuelve `true` sólo si ESTE llamador se quedó con
   * el turno; `false` si ya había un alta VIVA (o si el cliente no existe).
   *
   * ⚠️ Este método existe porque `getStatus()` + `setStatus('pending')` es un TOCTOU: entre las dos
   * llamadas hay un yield del event loop y dos POST concurrentes (un doble click alcanza, con UNA
   * sola réplica) producen DOS `register` REALES contra el partner ⇒ dos activaciones pendientes ⇒
   * cliente quemado PARA SIEMPRE. La condición y la escritura tienen que ser LA MISMA operación:
   * en Postgres, un `UPDATE … WHERE` condicional del que se ramifica por el `count`.
   *
   * En el éxito deja la fila en `pending`, sella `startedAt` = `heartbeatAt` = `startedAt` y LIMPIA
   * el `result` del intento anterior (si no, el polling del alta nueva mostraría el error viejo).
   *
   * El criterio de "viva" es el MISMO que `isTvRegisterJobActive`: pending/running con un heartbeat
   * más nuevo que `ttlMs`.
   */
  tryReserve(clientId: string, startedAt: Date, ttlMs: number): Promise<boolean>;

  /**
   * Escritura CON FENCING: sólo aplica si `expectedHeartbeatAt` sigue siendo el sello vigente de la
   * fila. Devuelve `false` si otra generación del job ya reservó el alta — o sea, si el llamador es
   * un runner ZOMBI.
   *
   * Sin esto, `jobId === customerId` y un overwrite ciego hacen que las dos generaciones sean
   * indistinguibles: un runner viejo que revive puede escribir `failed` sobre un alta que SÍ se
   * completó (el operador reintenta y quema al cliente) o `done` sobre una que falló.
   */
  compareAndSet(clientId: string, expectedHeartbeatAt: Date, row: TvRegisterStatusRow): Promise<boolean>;
}
