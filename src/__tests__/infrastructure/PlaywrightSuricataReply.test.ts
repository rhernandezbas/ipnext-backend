import { SuricataSession } from '@infrastructure/adapters/suricata/SuricataSession';
import {
  PlaywrightSuricataReply,
  type SuricataReplySession,
} from '@infrastructure/adapters/suricata/PlaywrightSuricataReply';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';

/**
 * suricata-tickets-mirror (Phase E, task E.1, D0/D3/D4) — orchestration
 * tests: `sendReply` acquires the shared session at 'high' priority and
 * releases it once done (D4 — 'high' jumps queued 'low'); this suite only
 * asserts the adapter wires session+externalId+body correctly. NOT wired
 * into `composeSuricataModule` yet — see `UnavailableSuricataReplyPort`.
 */
function makeFakeReplySession(overrides: Partial<SuricataReplySession> = {}): SuricataReplySession {
  return {
    isAuthenticated: jest.fn().mockResolvedValue(true),
    login: jest.fn().mockResolvedValue(undefined),
    sendMessage: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('PlaywrightSuricataReply', () => {
  const cfg = { sessionTimeoutMs: 20_000 };

  it('sendReply delegates to the session with the exact externalId and body', async () => {
    const replySession = makeFakeReplySession();
    const session = new SuricataSession(replySession, new InMemoryDistributedLock());
    const reply = new PlaywrightSuricataReply(session, cfg);

    await reply.sendReply('1001', 'Ya revisamos tu reclamo');

    expect(replySession.sendMessage).toHaveBeenCalledWith('1001', 'Ya revisamos tu reclamo');
  });

  it('acquires and releases the shared session per call (never holds it across calls)', async () => {
    const replySession = makeFakeReplySession();
    const lock = new InMemoryDistributedLock();
    const session = new SuricataSession(replySession, lock);
    const reply = new PlaywrightSuricataReply(session, cfg);

    await reply.sendReply('1001', 'hola');
    expect(lock.heldKeys.size).toBe(0);
  });

  it('propagates a send failure without swallowing it', async () => {
    const replySession = makeFakeReplySession({
      sendMessage: jest.fn().mockRejectedValue(new Error('DOM changed, could not find the reply box')),
    });
    const session = new SuricataSession(replySession, new InMemoryDistributedLock());
    const reply = new PlaywrightSuricataReply(session, cfg);

    await expect(reply.sendReply('1001', 'hola')).rejects.toThrow('DOM changed, could not find the reply box');
  });
});
