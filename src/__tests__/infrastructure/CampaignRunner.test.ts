/**
 * messaging-bulk (F2, T4.4, SEND-1) — `CampaignRunner`, molde
 * `ServiceCutRunner` (lock distribuido + shell fire-and-forget). `start()` es
 * rápido (valida estado + lock), el trabajo pesado corre en background.
 */
import { CampaignRunner, CAMPAIGN_LOCK_KEY } from '@infrastructure/scheduling/CampaignRunner';
import { InMemoryCampaignRepository } from '@infrastructure/adapters/in-memory/InMemoryCampaignRepository';
import { InMemoryDistributedLock } from '@infrastructure/adapters/in-memory/InMemoryDistributedLock';
import { CampaignAlreadyFinishedError, CampaignNotFoundError } from '@domain/errors/messaging-bulk';
import type { DistributedLock } from '@domain/ports/DistributedLock';
import type { Campaign } from '@domain/entities/campaign';

function build() {
  const campaignRepo = new InMemoryCampaignRepository();
  const lock = new InMemoryDistributedLock();
  return { campaignRepo, lock };
}

/**
 * FIX-3 — lock RE-ENTRANTE que reproduce la semántica de `PgAdvisoryLock`: una
 * ÚNICA sesión pg, así que `pg_try_advisory_lock` (misma sesión) devuelve `true`
 * DE NUEVO aunque ya lo tenga. El `InMemoryDistributedLock` NO reproduce esto
 * (devuelve `false` en el 2do acquire) → ENMASCARA el bug. Este fake es fiel a
 * producción: intra-réplica el lock NUNCA frena.
 */
class ReentrantDistributedLock implements DistributedLock {
  public acquireCalls = 0;
  async tryAcquire(_key: string): Promise<boolean> {
    this.acquireCalls++;
    return true; // misma sesión → siempre re-adquiere (re-entrante)
  }
  async release(_key: string): Promise<void> {
    // no-op
  }
}

async function seedCampaign(campaignRepo: InMemoryCampaignRepository): Promise<Campaign> {
  return campaignRepo.create({
    name: 'test',
    templateRef: 'HX1',
    segment: { statuses: [] },
    variableSpec: {},
    total: 1,
    createdById: 'user-1',
  });
}

describe('CampaignRunner (SEND-1)', () => {
  it('start: adquiere el lock, marca running+startedAt, corre el executor y libera el lock al terminar', async () => {
    const { campaignRepo, lock } = build();
    const campaign = await seedCampaign(campaignRepo);
    const sendCampaign = { execute: jest.fn().mockResolvedValue({ ...campaign, status: 'done' }) };
    const runner = new CampaignRunner(sendCampaign, campaignRepo, lock);

    const res = await runner.start(campaign.id);
    expect(res.accepted).toBe(true);
    await res.done;

    expect(sendCampaign.execute).toHaveBeenCalledWith({ campaignId: campaign.id });
    expect(lock.heldKeys.size).toBe(0); // lock liberado

    const marked = await campaignRepo.findById(campaign.id);
    expect(marked?.startedAt).toBeTruthy();
  });

  it('SEND-1 escenario 1: doble start concurrente sobre la MISMA campaña → el segundo accepted:false, sin correr un segundo run', async () => {
    const { campaignRepo, lock } = build();
    const campaign = await seedCampaign(campaignRepo);
    await lock.tryAcquire(CAMPAIGN_LOCK_KEY); // simula una corrida en curso de ESA campaña

    const sendCampaign = { execute: jest.fn() };
    const runner = new CampaignRunner(sendCampaign, campaignRepo, lock);

    const res = await runner.start(campaign.id);
    expect(res.accepted).toBe(false);
    expect(sendCampaign.execute).not.toHaveBeenCalled();
  });

  it('SEND-1 escenario 2: start sobre campaña ya done → CampaignAlreadyFinishedError, SIN tomar el lock', async () => {
    const { campaignRepo, lock } = build();
    const campaign = await seedCampaign(campaignRepo);
    await campaignRepo.update(campaign.id, { status: 'done' });

    const sendCampaign = { execute: jest.fn() };
    const runner = new CampaignRunner(sendCampaign, campaignRepo, lock);

    await expect(runner.start(campaign.id)).rejects.toThrow(CampaignAlreadyFinishedError);
    expect(lock.heldKeys.size).toBe(0); // nunca se tomó
    expect(sendCampaign.execute).not.toHaveBeenCalled();
  });

  it('campaignId inexistente → CampaignNotFoundError, sin tomar el lock', async () => {
    const { campaignRepo, lock } = build();
    const sendCampaign = { execute: jest.fn() };
    const runner = new CampaignRunner(sendCampaign, campaignRepo, lock);

    await expect(runner.start('nope')).rejects.toThrow(CampaignNotFoundError);
    expect(lock.heldKeys.size).toBe(0);
  });

  it('si el executor explota: la campaña queda failed y el lock se libera igual', async () => {
    const { campaignRepo, lock } = build();
    const campaign = await seedCampaign(campaignRepo);
    const sendCampaign = { execute: jest.fn().mockRejectedValue(new Error('boom')) };
    const runner = new CampaignRunner(sendCampaign, campaignRepo, lock);

    const res = await runner.start(campaign.id);
    await res.done;

    expect(lock.heldKeys.size).toBe(0);
    const updated = await campaignRepo.findById(campaign.id);
    expect(updated?.status).toBe('failed');
    expect(updated?.finishedAt).toBeTruthy();
  });

  it('FIX-3: doble start concurrente en la MISMA réplica con lock RE-ENTRANTE → un solo run (no doble-envío)', async () => {
    const { campaignRepo } = build();
    const campaign = await seedCampaign(campaignRepo);
    // Lock re-entrante (semántica PgAdvisoryLock, NO el InMemory no-re-entrante
    // que enmascara el bug): sin el guard in-process, AMBOS start() arrancarían.
    const lock = new ReentrantDistributedLock();
    const sendCampaign = {
      execute: jest.fn().mockImplementation(async () => {
        // trabajo con demora para que los dos start() se solapen de verdad.
        await new Promise((resolve) => setTimeout(resolve, 10));
        return { ...campaign, status: 'done' };
      }),
    };
    const runner = new CampaignRunner(sendCampaign, campaignRepo, lock);

    const [r1, r2] = await Promise.all([runner.start(campaign.id), runner.start(campaign.id)]);

    // Exactamente UNO arranca; el otro rechaza sin correr un segundo envío.
    const accepted = [r1, r2].filter((r) => r.accepted);
    expect(accepted).toHaveLength(1);
    await Promise.all([r1.done, r2.done].filter(Boolean) as Promise<void>[]);
    expect(sendCampaign.execute).toHaveBeenCalledTimes(1); // NO doble-envío
  });

  it('FIX-3: tras terminar un run, el guard in-process se libera → se puede volver a arrancar', async () => {
    const { campaignRepo } = build();
    const campaign = await seedCampaign(campaignRepo);
    const lock = new ReentrantDistributedLock();
    const sendCampaign = { execute: jest.fn().mockResolvedValue({ ...campaign, status: 'done' }) };
    const runner = new CampaignRunner(sendCampaign, campaignRepo, lock);

    const first = await runner.start(campaign.id);
    expect(first.accepted).toBe(true);
    await first.done;

    // Segundo arranque SECUENCIAL (el guard ya se liberó en el finally) → acepta.
    await campaignRepo.update(campaign.id, { status: 'running' });
    const second = await runner.start(campaign.id);
    expect(second.accepted).toBe(true);
    await second.done;

    expect(sendCampaign.execute).toHaveBeenCalledTimes(2);
  });

  it('resume: start() sobre una campaña running (worker reiniciado) con lock libre vuelve a correr el executor', async () => {
    const { campaignRepo, lock } = build();
    const campaign = await seedCampaign(campaignRepo);
    await campaignRepo.update(campaign.id, { status: 'running', startedAt: '2026-01-01T00:00:00.000Z' });

    const sendCampaign = { execute: jest.fn().mockResolvedValue({ ...campaign, status: 'done' }) };
    const runner = new CampaignRunner(sendCampaign, campaignRepo, lock);

    const res = await runner.start(campaign.id);
    expect(res.accepted).toBe(true);
    await res.done;

    expect(sendCampaign.execute).toHaveBeenCalledWith({ campaignId: campaign.id });
  });
});
