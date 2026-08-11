import type { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import type {
  ClientTvRegisterStatusRepository,
  TvRegisterStatusRow,
} from '@domain/ports/ClientTvRegisterStatusRepository';
import { TV_REGISTER_HEARTBEAT_MS } from '@domain/gigared/tvRegisterJob';

export interface RegisterTvActor {
  actorId: string | null;
  actorName: string;
}

/** Lo que la ruta le pasa al job. Espejo del input de `RegisterGigaredAccount.execute`. */
export interface RegisterTvJobInput {
  /** Tolerancia de deploy: el use case lo IGNORA (el nombre es BE-authoritative). */
  firstName: string;
  /** Tolerancia de deploy: el use case lo IGNORA. */
  lastName: string;
  /** Tolerancia de deploy: el use case lo IGNORA (el mail deriva del grContratoId). */
  email: string;
  sendActivationEmail: boolean;
  contractId: string;
}

/**
 * RegisterTvJobRunner (gigared-alta-asincrona W3) — cáscara asíncrona del alta de TV.
 *
 * La ruta RESERVA el turno (compare-and-set), responde 202 y dispara `void runner.run(...)`; el
 * runner reclama el `running`, late mientras avanza y termina en `done` | `failed`.
 *
 * POR QUÉ existe: un alta hace hasta 17 llamadas al partner, que corta a ~10 req por ventana de
 * 60 s. Un throttle honesto deja el alta en ~114 s sin tráfico de fondo y en 361 s con apenas
 * 6 req/min de ruido — por encima del `requestTimeout` de 300 s de Node. Cuando ese timeout corta
 * el socket, el operador ve un error y reintenta: segundo `register`, cliente quemado. Sacando el
 * alta del request, ese techo desaparece.
 *
 * `RegisterGigaredAccount` NO se toca: se invoca tal cual. Toda la idempotencia (probe por
 * internal_id, discriminador por email, avance DIFERIDO del seq) ya vive ahí, y reescribirla acá
 * crearía dos implementaciones de la misma regla — la que se testea y la que corre en prod.
 *
 * A diferencia del molde del cancel, no hace falta grabar el evento de TV: el propio use case ya
 * registra 'alta'/'reactivacion' best-effort.
 *
 * ── Las tres reglas que este archivo tiene que cumplir (fix wave) ─────────────────────────────
 *
 * 1) HEARTBEAT (C2). El lease se renueva mientras el job avanza. Sin eso el watchdog no puede
 *    distinguir "el proceso murió" de "el job está tardando" —y el alta tarda: 510 s de piso
 *    contra un TTL de 900 s— así que expira a un job VIVO, el GET dice "Podés reintentarla" y el
 *    sistema le PIDE al operador que dispare el segundo register.
 *
 * 2) FENCING (A4). Cada escritura presenta el sello vigente como token. Si otra generación tomó la
 *    reserva, este runner es un ZOMBI y no escribe NADA: ni su `done` sobre un alta que ya no le
 *    pertenece, ni su `failed` sobre una que salió bien.
 *
 * 3) `run` NUNCA LANZA (A2). Se invoca con `void`: un throw es un unhandled rejection y en Node
 *    moderno eso tumba el proceso — con todos los jobs en curso adentro. TODO camino, incluido el
 *    del heartbeat asíncrono, está envuelto.
 */
export class RegisterTvJobRunner {
  constructor(
    private readonly registerAccount: RegisterGigaredAccount,
    private readonly registerStatus: ClientTvRegisterStatusRepository,
    private readonly heartbeatMs: number = TV_REGISTER_HEARTBEAT_MS,
  ) {}

  /**
   * @param reservadoEn el sello con el que la RUTA reservó el turno. Es el fence token inicial:
   *        sin él, este runner no puede probar que el alta sigue siendo suya.
   */
  async run(
    customerId: string,
    input: RegisterTvJobInput,
    reservadoEn: Date,
    actor?: RegisterTvActor,
  ): Promise<void> {
    // Red de última instancia. Cualquier cosa que se escape acá (un bug nuestro, un throw síncrono
    // del repo, un error del propio logueo) muere en este catch y NO sube como unhandled rejection.
    try {
      await this.correr(customerId, input, reservadoEn, actor);
    } catch (err) {
      console.error('[gigared] register job: fallo no manejado en el runner', { customerId, err });
    }
  }

  private async correr(
    customerId: string,
    input: RegisterTvJobInput,
    reservadoEn: Date,
    actor?: RegisterTvActor,
  ): Promise<void> {
    // `token` es el sello vigente: cambia con cada latido y es lo que hay que presentar para
    // escribir. `startedAt` NO se mueve — es lo que el operador ve en el polling.
    let token = reservadoEn;

    // pending → running. Si el CAS no aplica, o somos un zombi (otra generación reservó) o la DB
    // no está: en los dos casos el lado seguro es NO tocar al partner. La fila queda en `pending`,
    // el watchdog la expira y el reintento del operador es idempotente. Arrancar el alta sin poder
    // registrar su estado sería un alta a ciegas.
    const claimAt = new Date();
    const reclamado = await this.escribir(customerId, token, {
      status: 'running',
      startedAt: reservadoEn,
      heartbeatAt: claimAt,
    });
    if (reclamado !== true) return;
    token = claimAt;

    // ── heartbeat ──────────────────────────────────────────────────────────────
    // Timer auto-reprogramado (no `setInterval`): así dos latidos nunca se solapan si la DB tarda
    // más que el intervalo.
    let latido: NodeJS.Timeout | null = null;
    let perdimosElTurno = false;
    const heartbeatMs = this.heartbeatMs;

    const beat = async (): Promise<void> => {
      const at = new Date();
      const ok = await this.escribir(customerId, token, {
        status: 'running',
        startedAt: reservadoEn,
        heartbeatAt: at,
      });
      if (ok === true) {
        token = at;
      } else if (ok === false) {
        // El sello cambió: otra generación se quedó con el alta. Dejamos de latir y NO vamos a
        // escribir el desenlace.
        perdimosElTurno = true;
        console.warn('[gigared] register job: otra generacion tomo la reserva, este runner es un zombi', { customerId });
        return;
      }
      // `ok === null` (la DB falló): no movemos el token y reintentamos en el próximo latido. El
      // TTL da ~30 latidos de margen, así que un blip no cuesta el turno.
      programar();
    };

    // El `void` + `.catch` es la parte 3) de la regla: el callback de un timer que rechaza es un
    // unhandled rejection que nadie puede atrapar desde afuera del timer.
    function programar(this: void): void {
      latido = setTimeout(() => {
        void beat().catch(err => {
          console.error('[gigared] register job: heartbeat roto', { customerId, err });
        });
      }, heartbeatMs);
      // Un job en vuelo no puede impedir que el proceso termine si el resto ya cerró.
      latido.unref?.();
    }
    programar();

    // ── el alta ────────────────────────────────────────────────────────────────
    // El try envuelve SÓLO la llamada al use case. La persistencia del desenlace va AFUERA: con el
    // `done` adentro, un blip de DB al guardar el ÉXITO caía en el catch y se persistía `failed` —
    // el operador veía un error de NUESTRA base como si fuera del partner, con la cuenta ya creada,
    // y reintentaba.
    let desenlace: TvRegisterStatusRow;
    try {
      const result = await this.registerAccount.execute(customerId, {
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        sendActivationEmail: input.sendActivationEmail,
        contractId: input.contractId,
        actorId: actor?.actorId ?? null,
        actorName: actor?.actorName ?? '',
      });
      desenlace = { status: 'done', result, startedAt: reservadoEn, heartbeatAt: new Date() };
    } catch (err) {
      // El mensaje es LO ÚNICO que el operador va a ver (decisión de producto: "el error y ya").
      // Por eso se persiste el texto del error de dominio tal cual, sin aplastarlo en un genérico.
      const error = err instanceof Error ? err.message : String(err);
      // Y el `code` viaja también: cuando el alta era síncrona, NO_CIC_AVAILABLE / TV_POOL_POISONED
      // / TV_EMAIL_OWNED_BY_OTHER llegaban al FE por HTTP y le permitían distinguir "el pool está
      // envenenado, llamá al admin" de "reintentá en unos segundos". Volverla asíncrona no puede
      // costar esa distinción en silencio.
      const rawCode = (err as { code?: unknown } | null)?.code;
      const code = typeof rawCode === 'string' ? rawCode : undefined;
      logForense(customerId, err, code);
      desenlace = {
        status: 'failed',
        result: code !== undefined ? { error, code } : { error },
        startedAt: reservadoEn,
        heartbeatAt: new Date(),
      };
    } finally {
      if (latido) clearTimeout(latido);
    }

    if (perdimosElTurno) return;
    await this.escribir(customerId, token, desenlace);
  }

  /**
   * Escritura con fence, blindada: `true` aplicó, `false` el token ya no vale (somos un zombi),
   * `null` la DB falló. Los tres casos son ramas distintas y ninguna puede propagar.
   */
  private async escribir(
    customerId: string,
    token: Date,
    row: TvRegisterStatusRow,
  ): Promise<boolean | null> {
    try {
      return await this.registerStatus.compareAndSet(customerId, token, row);
    } catch (err) {
      console.error('[gigared] register job: no se pudo persistir el estado', { customerId, status: row.status, err });
      return null;
    }
  }
}

/**
 * M3 — forense del fallo.
 *
 * El estado del job publica SÓLO `error` + `code`, y así tiene que seguir: hay un test que pinea
 * que el polling no filtre `ownedByInternalId`, `poisonedCount`, `cic` ni `internalId`. Pero ésos
 * son justamente los campos con los que se reconstruyó el incidente Centeno — `ownedByInternalId`
 * es el que dice QUIÉN se quedó con el mail. La salida no es publicarlos por HTTP: es dejarlos en
 * un log estructurado del servidor, donde el que investiga los tiene y el cliente no.
 */
function logForense(customerId: string, err: unknown, code: string | undefined): void {
  const e = (err ?? {}) as Record<string, unknown>;
  const datos: Record<string, unknown> = { customerId };
  if (code !== undefined) datos['code'] = code;
  if (err instanceof Error) datos['error'] = err.message;
  for (const campo of ['ownedByInternalId', 'poisonedCount', 'cic', 'internalId', 'email', 'attemptedCount', 'detail']) {
    if (e[campo] !== undefined) datos[campo] = e[campo];
  }
  console.warn('[gigared] register job: alta fallida', datos);
}
