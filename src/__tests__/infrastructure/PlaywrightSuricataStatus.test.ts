import { SuricataSession } from '@infrastructure/adapters/suricata/SuricataSession';
import { PlaywrightSuricataStatus, type SuricataStatusSession } from '@infrastructure/adapters/suricata/PlaywrightSuricataStatus';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { SuricataActionNotAppliedError } from '@domain/errors/suricata';

/**
 * suricata-bot-autonomous-actions (Phase E, task E.1, design D3.b, spec
 * STATUS-4/STATUS-7) — orchestration tests, molde
 * `PlaywrightSuricataInternalNote.test.ts`: `changeStatus` acquires the
 * shared session at 'high' priority and releases it once done; this suite
 * only asserts the adapter wires session+externalId+status correctly and
 * propagates a post-condition-marker failure without swallowing it. The
 * real DOM automation (`PlaywrightBrowserSession.changeTicketStatus`) is
 * exercised manually per the tasks.md focused-test-command table, not here.
 */
function makeFakeStatusSession(overrides: Partial<SuricataStatusSession> = {}): SuricataStatusSession {
  return {
    isAuthenticated: jest.fn().mockResolvedValue(true),
    login: jest.fn().mockResolvedValue(undefined),
    changeTicketStatus: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('PlaywrightSuricataStatus', () => {
  const cfg = { sessionTimeoutMs: 20_000 };

  it('changeStatus delegates to the session with the exact externalId and status', async () => {
    const statusSession = makeFakeStatusSession();
    const session = new SuricataSession(statusSession, new InMemoryDistributedLock());
    const status = new PlaywrightSuricataStatus(session, cfg);

    await status.changeStatus('1001', 'Progreso');

    expect(statusSession.changeTicketStatus).toHaveBeenCalledWith('1001', 'Progreso');
  });

  it('acquires and releases the shared session per call (never holds it across calls)', async () => {
    const statusSession = makeFakeStatusSession();
    const lock = new InMemoryDistributedLock();
    const session = new SuricataSession(statusSession, lock);
    const status = new PlaywrightSuricataStatus(session, cfg);

    await status.changeStatus('1001', 'Open');
    expect(lock.heldKeys.size).toBe(0);
  });

  it('requests the session at high priority (STATUS-4 — never behind the low-priority sync queue)', async () => {
    const statusSession = makeFakeStatusSession();
    const lock = new InMemoryDistributedLock();
    const session = new SuricataSession(statusSession, lock);
    const withSessionSpy = jest.spyOn(session, 'withSession');
    const status = new PlaywrightSuricataStatus(session, cfg);

    await status.changeStatus('1001', 'Open');

    expect(withSessionSpy).toHaveBeenCalledWith(
      { priority: 'high', timeoutMs: cfg.sessionTimeoutMs },
      expect.any(Function),
    );
  });

  it('propagates a post-condition-marker failure without swallowing it (SuricataActionNotAppliedError)', async () => {
    const statusSession = makeFakeStatusSession({
      changeTicketStatus: jest.fn().mockRejectedValue(new SuricataActionNotAppliedError()),
    });
    const session = new SuricataSession(statusSession, new InMemoryDistributedLock());
    const status = new PlaywrightSuricataStatus(session, cfg);

    await expect(status.changeStatus('1001', 'Open')).rejects.toThrow(SuricataActionNotAppliedError);
  });
});
