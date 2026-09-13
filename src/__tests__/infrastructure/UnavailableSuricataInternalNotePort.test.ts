import { UnavailableSuricataInternalNotePort } from '@infrastructure/adapters/suricata/UnavailableSuricataInternalNotePort';
import { SuricataAuthError } from '@domain/errors/suricata';

/**
 * suricata-bot-autonomous-actions (Phase D) — conservative fallback wired by
 * `bootstrapSuricataActionPorts.ts` whenever `SURICATA_BASE_URL`/
 * `SURICATA_BROWSER_WS` are unset, molde `UnavailableSuricataReplyPort.test.ts`:
 * proves the fallback always refuses instead of ever resolving silently.
 */
describe('UnavailableSuricataInternalNotePort', () => {
  it('addNote always throws SuricataAuthError (SURICATA_UNAVAILABLE), never posts anything', async () => {
    const port = new UnavailableSuricataInternalNotePort();

    await expect(port.addNote('ext-1', 'hola')).rejects.toThrow(SuricataAuthError);
    await expect(port.addNote('ext-1', 'hola')).rejects.toMatchObject({ code: 'SURICATA_UNAVAILABLE' });
  });
});
