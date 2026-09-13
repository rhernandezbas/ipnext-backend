import { isSuricataStatusValue, SURICATA_STATUS_VALUES } from '@domain/constants/suricataStatus';

/**
 * suricata-bot-autonomous-actions (Phase E, task E.2/E.3, design Threat
 * Matrix "Selector injection (new)") — `isSuricataStatusValue` is the ONLY
 * gate a caller-supplied status string crosses before `ChangeSuricataTicketStatus`
 * ever reaches `SuricataTicketStatusPort`/the Playwright driver. A status
 * value is never concatenated into a selector; this suite pins the gate
 * itself, independent of the use case/route wiring around it.
 */
describe('isSuricataStatusValue (Threat Matrix — selector injection guard)', () => {
  it('accepts every value in the B.4-captured catalog', () => {
    for (const value of SURICATA_STATUS_VALUES) {
      expect(isSuricataStatusValue(value)).toBe(true);
    }
  });

  it('rejects an empty string', () => {
    expect(isSuricataStatusValue('')).toBe(false);
  });

  it('rejects a value outside the captured catalog (e.g. a made-up "closed" literal)', () => {
    expect(isSuricataStatusValue('Cerrado')).toBe(false);
  });

  it('rejects a selector-injection-shaped string rather than letting it reach a driver', () => {
    expect(isSuricataStatusValue('"] ; DROP TABLE tickets; --')).toBe(false);
    expect(isSuricataStatusValue('Open"]')).toBe(false);
    expect(isSuricataStatusValue('Open, Progreso')).toBe(false);
  });

  it('is case-sensitive — a differently-cased known label is still rejected', () => {
    expect(isSuricataStatusValue('open')).toBe(false);
  });
});
