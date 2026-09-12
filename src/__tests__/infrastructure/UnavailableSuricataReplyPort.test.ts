import { UnavailableSuricataReplyPort } from '@infrastructure/adapters/suricata/UnavailableSuricataReplyPort';
import { SuricataReplyDriverUnavailableError } from '@domain/errors/suricata';

/**
 * suricata-tickets-mirror (Phase E) — this is the conservative guard this
 * apply session added on top of design/tasks: proves the port `composeSuricataModule`
 * wires TODAY always refuses, independent of any flag/RBAC state — see the
 * file's own doc comment for the full reasoning.
 */
describe('UnavailableSuricataReplyPort', () => {
  it('sendReply always throws SuricataReplyDriverUnavailableError (SURICATA_UNAVAILABLE), never sends anything', async () => {
    const port = new UnavailableSuricataReplyPort();

    await expect(port.sendReply('ext-1', 'hola')).rejects.toThrow(SuricataReplyDriverUnavailableError);
    await expect(port.sendReply('ext-1', 'hola')).rejects.toMatchObject({ code: 'SURICATA_UNAVAILABLE' });
  });
});
