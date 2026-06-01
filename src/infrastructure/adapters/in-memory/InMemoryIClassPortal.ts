import { IClassPortalPort } from '@domain/ports/IClassPortalPort';
import { ScrapedOSDetail } from '@domain/entities/iclass-portal';

/**
 * In-memory IClassPortalPort for use-case tests. Preload details per osId with
 * `set`; unknown ids return an empty detail (mirrors a closure page with no
 * survey / attachments).
 */
export class InMemoryIClassPortal implements IClassPortalPort {
  private readonly details = new Map<string, ScrapedOSDetail>();

  set(osId: string, detail: ScrapedOSDetail): void {
    this.details.set(osId, detail);
  }

  async getOSDetail(osId: string): Promise<ScrapedOSDetail> {
    return this.details.get(osId) ?? { questions: [], attachments: [] };
  }
}
