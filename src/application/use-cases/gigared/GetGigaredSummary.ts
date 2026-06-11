import type { GigaredPort, GigaredSummary } from '@domain/ports/GigaredPort';

/** GetGigaredSummary (#47) — proxies the partner summary (account counts + services). */
export class GetGigaredSummary {
  constructor(private readonly gigared: GigaredPort) {}

  async execute(): Promise<GigaredSummary> {
    return this.gigared.getSummary();
  }
}
