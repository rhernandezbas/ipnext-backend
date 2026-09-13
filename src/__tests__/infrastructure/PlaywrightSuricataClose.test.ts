import { SuricataSession } from '@infrastructure/adapters/suricata/SuricataSession';
import { PlaywrightSuricataClose, type SuricataCloseSession } from '@infrastructure/adapters/suricata/PlaywrightSuricataClose';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { SuricataActionNotAppliedError } from '@domain/errors/suricata';

/**
 * suricata-bot-autonomous-actions (Phase F, task F.1, design D3.b, spec
 * suricata-ticket-close CLOSE-4/CLOSE-7) — orchestration tests, molde
 * `PlaywrightSuricataStatus.test.ts`: `close` acquires the shared session at
 * 'high' priority and releases it once done; this suite only asserts the
 * adapter wires session+externalId+reason correctly and propagates a
 * post-condition-marker failure without swallowing it. The real DOM
 * automation (`PlaywrightBrowserSession.closeTicket`) is exercised manually
 * per the tasks.md focused-test-command table, not here.
 */
function makeFakeCloseSession(overrides: Partial<SuricataCloseSession> = {}): SuricataCloseSession {
  return {
    isAuthenticated: jest.fn().mockResolvedValue(true),
    login: jest.fn().mockResolvedValue(undefined),
    closeTicket: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('PlaywrightSuricataClose', () => {
  const cfg = { sessionTimeoutMs: 20_000 };

  it('close delegates to the session with the exact externalId and reason', async () => {
    const closeSession = makeFakeCloseSession();
    const session = new SuricataSession(closeSession, new InMemoryDistributedLock());
    const close = new PlaywrightSuricataClose(session, cfg);

    await close.close('1001', 'Reclamo resuelto');

    expect(closeSession.closeTicket).toHaveBeenCalledWith('1001', 'Reclamo resuelto');
  });

  it('acquires and releases the shared session per call (never holds it across calls)', async () => {
    const closeSession = makeFakeCloseSession();
    const lock = new InMemoryDistributedLock();
    const session = new SuricataSession(closeSession, lock);
    const close = new PlaywrightSuricataClose(session, cfg);

    await close.close('1001', 'Reclamo resuelto');
    expect(lock.heldKeys.size).toBe(0);
  });

  it('requests the session at high priority (CLOSE-4 — never behind the low-priority sync queue)', async () => {
    const closeSession = makeFakeCloseSession();
    const lock = new InMemoryDistributedLock();
    const session = new SuricataSession(closeSession, lock);
    const withSessionSpy = jest.spyOn(session, 'withSession');
    const close = new PlaywrightSuricataClose(session, cfg);

    await close.close('1001', 'Reclamo resuelto');

    expect(withSessionSpy).toHaveBeenCalledWith(
      { priority: 'high', timeoutMs: cfg.sessionTimeoutMs },
      expect.any(Function),
    );
  });

  it('propagates a post-condition-marker failure without swallowing it (SuricataActionNotAppliedError)', async () => {
    const closeSession = makeFakeCloseSession({
      closeTicket: jest.fn().mockRejectedValue(new SuricataActionNotAppliedError()),
    });
    const session = new SuricataSession(closeSession, new InMemoryDistributedLock());
    const close = new PlaywrightSuricataClose(session, cfg);

    await expect(close.close('1001', 'Reclamo resuelto')).rejects.toThrow(SuricataActionNotAppliedError);
  });
});
