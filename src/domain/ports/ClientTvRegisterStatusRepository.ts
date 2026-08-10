import type { GigaredAccount } from './GigaredPort';

/**
 * ClientTvRegisterStatusRepository (gigared-alta-asincrona W1.2) — estado del job de ALTA de TV.
 *
 * Espejo exacto de `ClientTvCancelStatusRepository`, pero para el alta. Persiste el estado en
 * curso / terminal del job en la DB espejo (tabla Client), en tres columnas nullable:
 *   tvRegisterStatus    — 'pending' | 'running' | 'done' | 'failed'
 *   tvRegisterResult    — result de RegisterGigaredAccount en done; {error:string} en failed
 *   tvRegisterStartedAt — cuándo se ENCOLÓ el job, re-sellado cuando el runner pasa a 'running'
 *
 * El sync de GR NUNCA escribe estas columnas — son estado mirror-only del job asíncrono.
 *
 * ⚠️ DIFERENCIA DELIBERADA con el molde del cancel: acá `startedAt` se escribe TAMBIÉN en
 * 'pending'. Sin ese timestamp el watchdog (`isTvRegisterJobActive`) no puede acotar la edad de un
 * job huérfano y el cliente queda bloqueado para siempre — que es exactamente el agujero abierto
 * de `CancelTvJobRunner`.
 *
 * Escribir el mismo estado dos veces siempre es seguro (last-write wins).
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

export interface TvRegisterStatusRow {
  status: TvRegisterStatusValue;
  result?: TvRegisterJobResult | { error: string };
  startedAt?: Date;
}

export interface ClientTvRegisterStatusRepository {
  /**
   * Lee el estado actual del alta para un cliente.
   * Devuelve null si nunca se encoló un alta para ese cliente.
   */
  getStatus(clientId: string): Promise<TvRegisterStatusRow | null>;

  /**
   * Escribe el estado del alta (con result / startedAt opcionales) para un cliente.
   * Crea o pisa el valor anterior atómicamente.
   */
  setStatus(clientId: string, row: TvRegisterStatusRow): Promise<void>;
}
