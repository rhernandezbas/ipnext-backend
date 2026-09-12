import type { SuricataReplyPort } from '@domain/ports/SuricataReplyPort';

/**
 * suricata-tickets-mirror (Phase E, task E.1) — spy/fake `SuricataReplyPort`
 * for route/use-case tests, molde `FakeSuricataScraper.ts` (Phase C). Records
 * every call so a test can assert exactly what was sent, and lets a test
 * inject a failure via `failWith`.
 */
export class FakeSuricataReply implements SuricataReplyPort {
  public readonly calls: Array<{ externalId: string; body: string }> = [];

  constructor(private readonly failWith: Error | null = null) {}

  async sendReply(externalId: string, body: string): Promise<void> {
    this.calls.push({ externalId, body });
    if (this.failWith) throw this.failWith;
  }
}
