/**
 * suricata-tickets-mirror (Phase B, D4) — `SuricataSession`, the mutex that
 * serializes access to the SINGLE authenticated Playwright session shared by
 * the sync job (Phase C, priority 'low') and the reply action (Phase E,
 * priority 'high'). Pure unit tests: no Playwright, no real Postgres — the
 * distributed lock is `InMemoryDistributedLock` (same fake used by
 * `CampaignRunner.test.ts`) and the Playwright session is a fake implementing
 * the narrow `SuricataAuthSession` duck-type this phase defines (Phase C/E's
 * real adapters wrap an actual `BrowserContext` behind that same interface).
 *
 * Covers tasks.md B.1 (queue priority/FIFO/timeout/release-on-throw) and B.2
 * (`ensureAuthenticated` DOM-marker classification, single re-login + single
 * retry) in one file, per the task's own grouping.
 */
import {
  SuricataSession,
  ensureAuthenticated,
  SURICATA_SESSION_LOCK_KEY,
  type SuricataAuthSession,
} from '@infrastructure/adapters/suricata/SuricataSession';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { SuricataSessionBusyError, SuricataAuthError } from '@domain/errors/suricata';

/**
 * Scripted fake session: `isAuthenticated()` returns the NEXT scripted value
 * (sticking to the last one once the script is exhausted), `login()` just
 * counts calls. Lets each test dictate the exact DOM-marker classification
 * sequence without a real browser.
 */
class FakeAuthSession implements SuricataAuthSession {
  private readonly script: boolean[];
  public loginCalls = 0;

  constructor(script: boolean[]) {
    this.script = [...script];
  }

  async isAuthenticated(): Promise<boolean> {
    if (this.script.length === 0) return true;
    return this.script.length > 1 ? (this.script.shift() as boolean) : this.script[0];
  }

  async login(): Promise<void> {
    this.loginCalls++;
  }
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('SuricataSession — mutex de prioridad + advisory lock (D4)', () => {
  it('caso feliz: corre fn con la sesión, y libera el advisory lock al terminar', async () => {
    const lock = new InMemoryDistributedLock();
    const session = new SuricataSession(new FakeAuthSession([true]), lock);

    const result = await session.withSession({ priority: 'low', timeoutMs: 1000 }, async (s) => {
      expect(await s.isAuthenticated()).toBe(true);
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(lock.heldKeys.has(SURICATA_SESSION_LOCK_KEY)).toBe(false);
  });

  it('high adelanta a los low ya encolados; FIFO dentro del mismo nivel', async () => {
    const session = new SuricataSession(new FakeAuthSession([true]), new InMemoryDistributedLock());
    const order: string[] = [];
    const mkFn = (label: string) => async () => {
      order.push(label);
    };

    // Llamadas SIN await entre sí: la primera toma el mutex sincrónicamente
    // (check+set antes del primer await, molde CampaignRunner.heldInProcess),
    // las siguientes tres quedan encoladas ANTES de que la primera corra su fn.
    const pA = session.withSession({ priority: 'low', timeoutMs: 2000 }, mkFn('A'));
    const pB = session.withSession({ priority: 'low', timeoutMs: 2000 }, mkFn('B'));
    const pC = session.withSession({ priority: 'low', timeoutMs: 2000 }, mkFn('C'));
    const pD = session.withSession({ priority: 'high', timeoutMs: 2000 }, mkFn('D'));

    await Promise.all([pA, pB, pC, pD]);

    // A ya estaba corriendo; D (high) salta delante de B y C (low, encolados
    // en ese orden) pero no delante de A, que ya había arrancado.
    expect(order).toEqual(['A', 'D', 'B', 'C']);
  });

  it('timeout mientras espera en cola ⇒ SuricataSessionBusyError, sin afectar al que ya tiene la sesión', async () => {
    const session = new SuricataSession(new FakeAuthSession([true]), new InMemoryDistributedLock());
    const hold = deferred<void>();

    const pHold = session.withSession({ priority: 'low', timeoutMs: 5000 }, async () => {
      await hold.promise;
      return 'held-done';
    });

    await expect(
      session.withSession({ priority: 'low', timeoutMs: 20 }, async () => 'never'),
    ).rejects.toThrow(SuricataSessionBusyError);

    hold.resolve();
    await expect(pHold).resolves.toBe('held-done');
  });

  it('el mutex se libera aunque fn tire, y la sesión sigue usable después', async () => {
    const session = new SuricataSession(new FakeAuthSession([true]), new InMemoryDistributedLock());

    await expect(
      session.withSession({ priority: 'low', timeoutMs: 1000 }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    // Si el mutex no se hubiera liberado, esta segunda llamada colgaría hasta
    // su propio timeout y el test fallaría.
    const ran = await session.withSession({ priority: 'low', timeoutMs: 1000 }, async () => 'ok');
    expect(ran).toBe('ok');
  });

  it('PgAdvisoryLock ocupado por OTRA réplica ⇒ SuricataSessionBusyError, y libera el slot in-process', async () => {
    const lock = new InMemoryDistributedLock();
    lock.forceAcquireFails = true;
    const session = new SuricataSession(new FakeAuthSession([true]), lock);

    await expect(
      session.withSession({ priority: 'low', timeoutMs: 1000 }, async () => 'never'),
    ).rejects.toThrow(SuricataSessionBusyError);

    lock.forceAcquireFails = false;
    const ran = await session.withSession({ priority: 'low', timeoutMs: 1000 }, async () => 'ok');
    expect(ran).toBe('ok');
  });

  it('withSession no autenticado y el retry también falla ⇒ SuricataAuthError propaga, fn NUNCA se invoca, mutex se libera', async () => {
    // 1er withSession: isAuthenticated=false, login, re-chequeo=false ⇒ SuricataAuthError
    // (consume los primeros 2). 2do withSession (llamada NUEVA, clasificación FRESCA por
    // diseño D4): isAuthenticated=true ⇒ éxito, sin login adicional — prueba que el mutex
    // sigue usable después del fallo, no que la MISMA clasificación se vuelva a intentar.
    const fake = new FakeAuthSession([false, false, true]);
    const session = new SuricataSession(fake, new InMemoryDistributedLock());
    const fn = jest.fn();

    await expect(session.withSession({ priority: 'low', timeoutMs: 1000 }, fn)).rejects.toThrow(
      SuricataAuthError,
    );
    expect(fn).not.toHaveBeenCalled();
    expect(fake.loginCalls).toBe(1);

    // el mutex quedó liberado pese al fallo de auth
    const ran = await session.withSession(
      { priority: 'low', timeoutMs: 1000 },
      async () => 'ok',
    );
    expect(ran).toBe('ok');
    expect(fake.loginCalls).toBe(1); // sin login extra: la 2da llamada YA estaba autenticada
  });
});

describe('ensureAuthenticated (D4 — clasificación por marcador de DOM, single re-login + single retry)', () => {
  it('ya autenticado ⇒ no llama a login', async () => {
    const fake = new FakeAuthSession([true]);
    await ensureAuthenticated(fake);
    expect(fake.loginCalls).toBe(0);
  });

  it('no autenticado ⇒ login UNA vez, re-chequea, éxito', async () => {
    const fake = new FakeAuthSession([false, true]);
    await ensureAuthenticated(fake);
    expect(fake.loginCalls).toBe(1);
  });

  it('sigue sin autenticar tras el login ⇒ SuricataAuthError, login llamado UNA sola vez (sin loop)', async () => {
    const fake = new FakeAuthSession([false, false]);
    await expect(ensureAuthenticated(fake)).rejects.toThrow(SuricataAuthError);
    expect(fake.loginCalls).toBe(1);
  });
});
