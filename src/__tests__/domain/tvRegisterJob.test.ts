/**
 * gigared-alta-asincrona W1.3 — WATCHDOG del job de alta huérfano.
 *
 * Este es el agujero que `CancelTvJobRunner` tiene HOY y que este change NO hereda: un job que
 * queda en `running` porque el proceso murió (deploy, OOM, restart) bloquea al cliente PARA
 * SIEMPRE — no hay forma de volver a operar sin tocar la DB a mano.
 *
 * La regla vive en el dominio como función PURA (`isTvRegisterJobActive`) para que el guard de la
 * ruta y el endpoint de estado usen LA MISMA decisión. Si la regla viviera duplicada en los dos
 * lugares, el test certificaría una copia y producción correría la otra.
 *
 * Los relojes de estos tests salen de `Date.now()` REAL, nunca de un origen virtual tipo
 * `1_000_000`: en las rondas previas de este mismo bug un test pasaba por accidente porque al
 * restarle una hora a un reloj virtual el tiempo se volvía negativo y cumplía la condición solo.
 */
import {
  TV_REGISTER_JOB_TTL_MS,
  isTvRegisterJobActive,
} from '@domain/gigared/tvRegisterJob';
import type { TvRegisterStatusRow } from '@domain/ports/ClientTvRegisterStatusRepository';

const now = () => new Date();
const hace = (ms: number) => new Date(Date.now() - ms);

describe('isTvRegisterJobActive — watchdog del alta huérfana (W1.3)', () => {
  it('TTL por defecto: 15 minutos (el alta más lenta medida fue ~369 s)', () => {
    expect(TV_REGISTER_JOB_TTL_MS).toBe(15 * 60 * 1000);
  });

  it('pending recién encolado → ACTIVO (bloquea un segundo disparo)', () => {
    const row: TvRegisterStatusRow = { status: 'pending', startedAt: now() };
    expect(isTvRegisterJobActive(row, new Date())).toBe(true);
  });

  it('running recién arrancado → ACTIVO', () => {
    const row: TvRegisterStatusRow = { status: 'running', startedAt: hace(30_000) };
    expect(isTvRegisterJobActive(row, new Date())).toBe(true);
  });

  it('running de hace 6 minutos → ACTIVO (un alta real tarda hasta ~369 s)', () => {
    const row: TvRegisterStatusRow = { status: 'running', startedAt: hace(6 * 60 * 1000) };
    expect(isTvRegisterJobActive(row, new Date())).toBe(true);
  });

  // ── EL TEST DE W1.3 ───────────────────────────────────────────────────────────
  it('running VIEJO (proceso muerto) → NO activo: el cliente NO queda bloqueado', () => {
    const row: TvRegisterStatusRow = { status: 'running', startedAt: hace(TV_REGISTER_JOB_TTL_MS + 1) };
    expect(isTvRegisterJobActive(row, new Date())).toBe(false);
  });

  it('pending huérfano VIEJO (murió entre el encolado y el runner) → NO activo', () => {
    const row: TvRegisterStatusRow = { status: 'pending', startedAt: hace(TV_REGISTER_JOB_TTL_MS + 1) };
    expect(isTvRegisterJobActive(row, new Date())).toBe(false);
  });

  it('borde: edad == TTL → NO activo; edad == TTL-1ms → ACTIVO', () => {
    const ahora = new Date();
    const justo: TvRegisterStatusRow = { status: 'running', startedAt: new Date(ahora.getTime() - TV_REGISTER_JOB_TTL_MS) };
    const casi: TvRegisterStatusRow = { status: 'running', startedAt: new Date(ahora.getTime() - (TV_REGISTER_JOB_TTL_MS - 1)) };
    expect(isTvRegisterJobActive(justo, ahora)).toBe(false);
    expect(isTvRegisterJobActive(casi, ahora)).toBe(true);
  });

  it('done y failed NUNCA están activos (siempre re-encolables)', () => {
    expect(isTvRegisterJobActive({ status: 'done', startedAt: now() }, new Date())).toBe(false);
    expect(isTvRegisterJobActive({ status: 'failed', startedAt: now() }, new Date())).toBe(false);
  });

  it('fila ausente (null) → NO activo', () => {
    expect(isTvRegisterJobActive(null, new Date())).toBe(false);
  });

  /**
   * Lado SEGURO ante datos que nosotros nunca escribimos: sin `startedAt` la edad del job es
   * INDETERMINABLE. El daño de no bloquear (dos altas concurrentes que ambas fallan el probe y
   * registran dos veces = cliente quemado) es peor y PERMANENTE; el de bloquear es operativo y
   * reversible. Nuestro código siempre escribe startedAt, así que esta rama es inalcanzable en
   * producción — existe sólo para que basura en la columna no abra el camino peligroso.
   */
  it('pending/running SIN startedAt → ACTIVO (edad indeterminable → lado seguro)', () => {
    expect(isTvRegisterJobActive({ status: 'running' }, new Date())).toBe(true);
    expect(isTvRegisterJobActive({ status: 'pending' }, new Date())).toBe(true);
  });

  it('el TTL es inyectable (la ruta y el status endpoint comparten esta misma función)', () => {
    const row: TvRegisterStatusRow = { status: 'running', startedAt: hace(2_000) };
    expect(isTvRegisterJobActive(row, new Date(), 1_000)).toBe(false);
    expect(isTvRegisterJobActive(row, new Date(), 60_000)).toBe(true);
  });

  // ── C2 (fix wave): el watchdog mide SEÑAL DE VIDA, no antigüedad ────────────────
  /**
   * El bug: `startedAt` se sellaba UNA vez y no se renovaba nunca, así que el watchdog no podía
   * distinguir "el proceso murió" de "el job está tardando". Y el alta TARDA: 17 llamadas × 30 s de
   * timeout = 510 s de piso, con un TTL de 900 s. Medido por los revisores: con el runner colgado
   * DENTRO del register, el GET devolvía `expired` ("Podés reintentarla") y un segundo POST daba
   * 202. O sea: el sistema le PEDÍA al operador que disparara el segundo register — exactamente lo
   * que quemó a Calabria, Abello y Aceste.
   *
   * El arreglo es un heartbeat: el runner re-sella `heartbeatAt` mientras avanza. El watchdog mide
   * contra ESE sello. `startedAt` queda INMUTABLE (es lo que el operador ve en el polling; moverlo
   * cada 30 s sería mentirle sobre cuándo arrancó el alta).
   */
  it('job LENTO pero vivo: heartbeat fresco con startedAt viejo → ACTIVO (no se le roba el lock)', () => {
    const row: TvRegisterStatusRow = {
      status: 'running',
      startedAt: hace(TV_REGISTER_JOB_TTL_MS + 10 * 60 * 1000), // arrancó hace 25 minutos
      heartbeatAt: hace(5_000),                                  // pero dio señal hace 5 segundos
    };
    expect(isTvRegisterJobActive(row, new Date())).toBe(true);
  });

  it('proceso MUERTO: heartbeat más viejo que el TTL → NO activo (el cliente se libera)', () => {
    const row: TvRegisterStatusRow = {
      status: 'running',
      startedAt: hace(TV_REGISTER_JOB_TTL_MS + 60_000),
      heartbeatAt: hace(TV_REGISTER_JOB_TTL_MS + 1),
    };
    expect(isTvRegisterJobActive(row, new Date())).toBe(false);
  });

  it('el heartbeat MANDA sobre startedAt: startedAt recién sellado no revive un heartbeat muerto', () => {
    // La rama inversa. Si la función usara `startedAt ?? heartbeatAt` (o los mirara al revés), este
    // caso daría ACTIVO y un job muerto seguiría bloqueando al cliente.
    const row: TvRegisterStatusRow = {
      status: 'running',
      startedAt: now(),
      heartbeatAt: hace(TV_REGISTER_JOB_TTL_MS + 1),
    };
    expect(isTvRegisterJobActive(row, new Date())).toBe(false);
  });

  it('sin heartbeatAt cae a startedAt (filas escritas antes de este change)', () => {
    expect(isTvRegisterJobActive({ status: 'running', startedAt: hace(1_000) }, new Date())).toBe(true);
    expect(isTvRegisterJobActive({ status: 'running', startedAt: hace(TV_REGISTER_JOB_TTL_MS + 1) }, new Date())).toBe(false);
  });
});
