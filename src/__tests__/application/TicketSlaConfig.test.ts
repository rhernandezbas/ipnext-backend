import { describe, it, expect } from '@jest/globals';
import { GetTicketSlaConfig } from '@application/use-cases/GetTicketSlaConfig';
import { UpdateTicketSlaConfig } from '@application/use-cases/UpdateTicketSlaConfig';
import { InMemoryTicketSlaConfigRepository } from '../../infrastructure/adapters/in-memory/InMemoryTicketSlaConfigRepository';
import { TicketSlaThresholdOrderError } from '@domain/errors/tickets';

describe('#79 GetTicketSlaConfig', () => {
  it('returns defaults (warn 60 / danger 240) when no record exists', async () => {
    const repo = new InMemoryTicketSlaConfigRepository();
    const result = await new GetTicketSlaConfig(repo).execute();
    expect(result).toEqual({ warnMinutes: 60, dangerMinutes: 240 });
  });

  it('returns the current persisted config', async () => {
    const repo = new InMemoryTicketSlaConfigRepository();
    await repo.update({ warnMinutes: 30, dangerMinutes: 120 });
    const result = await new GetTicketSlaConfig(repo).execute();
    expect(result).toEqual({ warnMinutes: 30, dangerMinutes: 120 });
  });
});

describe('#79 UpdateTicketSlaConfig', () => {
  it('persists a full valid patch and returns the merged config', async () => {
    const repo = new InMemoryTicketSlaConfigRepository();
    const result = await new UpdateTicketSlaConfig(repo).execute({ warnMinutes: 90, dangerMinutes: 300 });
    expect(result).toEqual({ warnMinutes: 90, dangerMinutes: 300 });
  });

  it('validates the invariant against the MERGED config (partial warnMinutes only)', async () => {
    const repo = new InMemoryTicketSlaConfigRepository();
    // default danger is 240; bumping warn to 100 still leaves danger > warn → ok
    const result = await new UpdateTicketSlaConfig(repo).execute({ warnMinutes: 100 });
    expect(result).toEqual({ warnMinutes: 100, dangerMinutes: 240 });
  });

  it('rejects when merged dangerMinutes <= warnMinutes and writes nothing', async () => {
    const repo = new InMemoryTicketSlaConfigRepository();
    // default danger 240; setting warn to 300 would break the order
    await expect(new UpdateTicketSlaConfig(repo).execute({ warnMinutes: 300 }))
      .rejects.toBeInstanceOf(TicketSlaThresholdOrderError);
    // nothing persisted → still defaults
    expect(await repo.get()).toEqual({ warnMinutes: 60, dangerMinutes: 240 });
  });

  it('rejects an equal-thresholds patch (danger must be strictly greater)', async () => {
    const repo = new InMemoryTicketSlaConfigRepository();
    await expect(new UpdateTicketSlaConfig(repo).execute({ warnMinutes: 120, dangerMinutes: 120 }))
      .rejects.toBeInstanceOf(TicketSlaThresholdOrderError);
  });
});
