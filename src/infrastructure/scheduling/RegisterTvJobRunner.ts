import type { RegisterGigaredAccount } from '@application/use-cases/gigared/RegisterGigaredAccount';
import type { ClientTvRegisterStatusRepository } from '@domain/ports/ClientTvRegisterStatusRepository';

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
 * Molde de `CancelTvJobRunner`: la ruta escribe `pending`, responde 202 y dispara
 * `void runner.run(...)`; el runner pasa a `running` y termina en `done` | `failed`.
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
 * `run` NUNCA lanza: se invoca con `void` (fire-and-forget) y un throw sería un unhandled
 * rejection que en Node moderno tumba el proceso.
 */
export class RegisterTvJobRunner {
  constructor(
    private readonly registerAccount: RegisterGigaredAccount,
    private readonly registerStatus: ClientTvRegisterStatusRepository,
  ) {}

  async run(customerId: string, input: RegisterTvJobInput, actor?: RegisterTvActor): Promise<void> {
    const startedAt = new Date();
    // pending → running. El `startedAt` se re-sella acá a propósito: el watchdog mide el tiempo
    // desde que el trabajo REAL arrancó, no desde que se encoló.
    await this.registerStatus.setStatus(customerId, { status: 'running', startedAt });

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
      await this.registerStatus.setStatus(customerId, { status: 'done', result, startedAt });
    } catch (err) {
      // El mensaje es LO ÚNICO que el operador va a ver (decisión de producto: "el error y ya").
      // Por eso se persiste el texto del error de dominio tal cual, sin aplastarlo en un genérico.
      const error = err instanceof Error ? err.message : String(err);
      await this.registerStatus.setStatus(customerId, { status: 'failed', result: { error }, startedAt });
    }
  }
}
