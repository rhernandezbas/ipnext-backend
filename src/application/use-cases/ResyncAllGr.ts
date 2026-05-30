import { ResetGrClientsCursor, ResetGrClientsCursorResult } from './ResetGrClientsCursor';
import { ArmGrContractsBackfill, ArmGrContractsBackfillResult } from './ArmGrContractsBackfill';

export interface ResyncAllGrResult {
  clients: ResetGrClientsCursorResult;
  contractsBackfill: ArmGrContractsBackfillResult;
}

/**
 * "Re-sincronizar todo" orchestrator: resets the gr-clients cursor (forcing a
 * full client re-backfill next tick) AND arms the gr-contracts-backfill watermark
 * at offset 0 (so subsequent ticks drain the contract backfill from the start).
 *
 * Pure composition of two existing/new use cases — no new repository, no
 * infrastructure import. Idempotent because both collaborators are.
 */
export class ResyncAllGr {
  constructor(
    private readonly resetClients: ResetGrClientsCursor,
    private readonly armBackfill: ArmGrContractsBackfill,
  ) {}

  async execute(): Promise<ResyncAllGrResult> {
    const clients = await this.resetClients.execute();
    const contractsBackfill = await this.armBackfill.execute();
    return { clients, contractsBackfill };
  }
}
