/**
 * fix wave F1 (F3) — `AsyncMutex`. Primitiva nueva: se testea sola, además de
 * end-to-end en `SendExternalBulk.test.ts`. Lo load-bearing acá es que un
 * RECHAZO no trabe la cola (si el gate de crédito tira un 422, los `send` que
 * vienen atrás tienen que seguir corriendo).
 */
import { AsyncMutex } from '@application/use-cases/messaging/asyncMutex';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('AsyncMutex', () => {
  it('serializa: el segundo turno no ARRANCA hasta que el primero termina', async () => {
    const mutex = new AsyncMutex();
    const gate = deferred<void>();
    const order: string[] = [];

    const first = mutex.runExclusive(async () => {
      order.push('first:start');
      await gate.promise;
      order.push('first:end');
    });
    const second = mutex.runExclusive(async () => {
      order.push('second:start');
    });

    // Con el primero todavía adentro, el segundo NO empezó.
    await Promise.resolve();
    expect(order).toEqual(['first:start']);

    gate.resolve();
    await Promise.all([first, second]);

    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('un RECHAZO no traba la cola: el turno siguiente corre igual', async () => {
    const mutex = new AsyncMutex();
    const ran: string[] = [];

    const failing = mutex.runExclusive(async () => {
      ran.push('a');
      throw new Error('boom');
    });
    const next = mutex.runExclusive(async () => {
      ran.push('b');
      return 'ok';
    });

    await expect(failing).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
    expect(ran).toEqual(['a', 'b']);
  });

  it('el error se propaga SOLO al llamador de ese turno, no al siguiente', async () => {
    const mutex = new AsyncMutex();

    await expect(
      mutex.runExclusive(async () => {
        throw new Error('primero');
      }),
    ).rejects.toThrow('primero');
    await expect(mutex.runExclusive(async () => 42)).resolves.toBe(42);
  });

  it('devuelve el valor de la función, tipado', async () => {
    const mutex = new AsyncMutex();

    const result = await mutex.runExclusive(async () => ({ campaignId: 'c-1', total: 3 }));

    expect(result).toEqual({ campaignId: 'c-1', total: 3 });
  });

  it('mantiene el ORDEN FIFO de 5 turnos concurrentes', async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        mutex.runExclusive(async () => {
          await Promise.resolve();
          order.push(n);
        }),
      ),
    );

    expect(order).toEqual([1, 2, 3, 4, 5]);
  });
});
