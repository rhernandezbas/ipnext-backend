/**
 * fix wave F1 (F3) — mutex EN PROCESO, sin dependencias nuevas. Molde de
 * ubicación: `externalBulkPayloadHash.ts` (helper puro, junto a su único
 * consumidor).
 *
 * Por qué existe: el gate de crédito de `SendExternalBulk` es un
 * check-then-act (leer saldo → crear campaña). Dos `send` que entran a la vez
 * leen el MISMO saldo y ambos pasan: 2 × 8 USD gastados con 10 de saldo. La
 * cadena de promesas serializa el tramo entero (gate + CreateCampaign +
 * markConsumed), con lo cual el segundo lee el saldo YA drenado por el primero.
 *
 * ALCANCE DECLARADO: esto protege UNA instancia del proceso, no un cluster.
 * Es suficiente acá y no es una promesa a medias: `CampaignRunner` ya es uno
 * por proceso (D6, lock global), así que el camino de envío externo vive en un
 * solo proceso por diseño. Si eso cambiara, el candado tendría que subir a la
 * DB (advisory lock, el mismo molde que ya usa el runner) — está anotado en
 * design.md D10.a.
 *
 * `runExclusive` NUNCA se traba por un rechazo previo: la cola avanza igual
 * (el error se propaga al llamador de ESE turno, no a los que siguen).
 */
export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
