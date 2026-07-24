/**
 * F1 (noc-alerts-config, lado BE) — InMemoryNocAlertThresholdsConfigRepository:
 * singleton get/update. Molde InMemoryNocBroadcastConfigRepository, PERO
 * `update()` reemplaza TODO el config (no merge parcial) — spec.md "Update
 * validates required numeric fields": el PUT humano manda los 5 campos
 * completos siempre, un payload incompleto se rechaza en la capa de
 * validación (Zod, en la route) ANTES de llegar acá.
 */
import { InMemoryNocAlertThresholdsConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocAlertThresholdsConfigRepository';
import { NOC_ALERT_THRESHOLDS_DEFAULTS } from '@domain/ports/NocAlertThresholdsConfigRepository';

describe('InMemoryNocAlertThresholdsConfigRepository', () => {
  it('get() returns the seeded defaults before any row is persisted', async () => {
    const repo = new InMemoryNocAlertThresholdsConfigRepository();
    expect(await repo.get()).toEqual(NOC_ALERT_THRESHOLDS_DEFAULTS);
    expect(await repo.get()).toEqual({
      critDbm: -30,
      warnDbm: -27,
      deltaAlert: 2.0,
      ponMinAbon: 2,
      ponDelta: 1.5,
    });
  });

  it('update() replaces the full config and round-trips it', async () => {
    const repo = new InMemoryNocAlertThresholdsConfigRepository();
    const updated = await repo.update({
      critDbm: -28,
      warnDbm: -25,
      deltaAlert: 1.5,
      ponMinAbon: 3,
      ponDelta: 1.0,
    });
    expect(updated).toEqual({
      critDbm: -28,
      warnDbm: -25,
      deltaAlert: 1.5,
      ponMinAbon: 3,
      ponDelta: 1.0,
    });
    expect(await repo.get()).toEqual(updated);
  });
});
