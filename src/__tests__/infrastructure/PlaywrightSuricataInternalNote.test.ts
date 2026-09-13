import { SuricataSession } from '@infrastructure/adapters/suricata/SuricataSession';
import {
  PlaywrightSuricataInternalNote,
  type SuricataInternalNoteSession,
} from '@infrastructure/adapters/suricata/PlaywrightSuricataInternalNote';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { SuricataActionNotAppliedError } from '@domain/errors/suricata';

/**
 * suricata-bot-autonomous-actions (Phase D, task D.1, design D3.b, spec
 * NOTE-4/NOTE-7) — orchestration tests, molde `PlaywrightSuricataReply.test.ts`:
 * `addNote` acquires the shared session at 'high' priority and releases it
 * once done; this suite only asserts the adapter wires
 * session+externalId+text correctly and fails closed per NOTE-7 when the
 * detail page's own ticket-id context doesn't match.
 */
function makeFakeNoteSession(overrides: Partial<SuricataInternalNoteSession> = {}): SuricataInternalNoteSession {
  return {
    isAuthenticated: jest.fn().mockResolvedValue(true),
    login: jest.fn().mockResolvedValue(undefined),
    postNote: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('PlaywrightSuricataInternalNote', () => {
  const cfg = { sessionTimeoutMs: 20_000 };

  it('addNote delegates to the session with the exact externalId and text', async () => {
    const noteSession = makeFakeNoteSession();
    const session = new SuricataSession(noteSession, new InMemoryDistributedLock());
    const note = new PlaywrightSuricataInternalNote(session, cfg);

    await note.addNote('1001', 'Escalado a NOC');

    expect(noteSession.postNote).toHaveBeenCalledWith('1001', 'Escalado a NOC');
  });

  it('acquires and releases the shared session per call (never holds it across calls)', async () => {
    const noteSession = makeFakeNoteSession();
    const lock = new InMemoryDistributedLock();
    const session = new SuricataSession(noteSession, lock);
    const note = new PlaywrightSuricataInternalNote(session, cfg);

    await note.addNote('1001', 'hola');
    expect(lock.heldKeys.size).toBe(0);
  });

  it('requests the session at high priority (NOTE-4 — never behind the low-priority sync queue)', async () => {
    const noteSession = makeFakeNoteSession();
    const lock = new InMemoryDistributedLock();
    const session = new SuricataSession(noteSession, lock);
    const withSessionSpy = jest.spyOn(session, 'withSession');
    const note = new PlaywrightSuricataInternalNote(session, cfg);

    await note.addNote('1001', 'hola');

    expect(withSessionSpy).toHaveBeenCalledWith(
      { priority: 'high', timeoutMs: cfg.sessionTimeoutMs },
      expect.any(Function),
    );
  });

  it('propagates a post-condition-marker failure without swallowing it (SuricataActionNotAppliedError)', async () => {
    const noteSession = makeFakeNoteSession({
      postNote: jest.fn().mockRejectedValue(new SuricataActionNotAppliedError()),
    });
    const session = new SuricataSession(noteSession, new InMemoryDistributedLock());
    const note = new PlaywrightSuricataInternalNote(session, cfg);

    await expect(note.addNote('1001', 'hola')).rejects.toThrow(SuricataActionNotAppliedError);
  });
});
