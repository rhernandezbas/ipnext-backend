import {
  normalizeFinanceReceiptSyncConfig,
  FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS,
} from '@domain/ports/FinanceReceiptSyncConfigRepository';
import { PrismaFinanceReceiptSyncConfigRepository } from '@infrastructure/adapters/prisma/PrismaFinanceReceiptSyncConfigRepository';
import { InMemoryFinanceReceiptSyncConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryFinanceReceiptSyncConfigRepository';
import { prisma } from '@infrastructure/database/prisma';

/**
 * gr-receipt-annulment (design.md Decision 7) — "basura al lado SEGURO, no al
 * default". Table below is the FULL basura→seguro matrix, run against the
 * PURE normalizer directly AND against both adapters' `get()` (U5, design.md
 * Testing strategy) — if only one adapter honored the rules, tests would
 * certify a world production doesn't run.
 */
describe('normalizeFinanceReceiptSyncConfig', () => {
  it('a fully-valid config passes through unchanged', () => {
    const valid = { ...FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS, reconcileWindowDays: 60, annulmentGuardMaxPct: 10 };
    expect(normalizeFinanceReceiptSyncConfig(valid)).toEqual(valid);
  });

  describe('reconcileEnabled', () => {
    it('a non-boolean falls back to the default (true)', () => {
      expect(normalizeFinanceReceiptSyncConfig({ reconcileEnabled: 'nope' as unknown as boolean }).reconcileEnabled).toBe(true);
    });
    it('an explicit false is honored — apagar es una decision EXPLICITA', () => {
      expect(normalizeFinanceReceiptSyncConfig({ reconcileEnabled: false }).reconcileEnabled).toBe(false);
    });
  });

  describe('reconcileWindowDays — extremo peligroso es el BAJO (0 = feature inerte)', () => {
    it('0 falls back to 35, never clamped to 1', () => {
      expect(normalizeFinanceReceiptSyncConfig({ reconcileWindowDays: 0 }).reconcileWindowDays).toBe(35);
    });
    it('a negative value falls back to 35', () => {
      expect(normalizeFinanceReceiptSyncConfig({ reconcileWindowDays: -5 }).reconcileWindowDays).toBe(35);
    });
    it('a value INSIDE the nominal [1,90] range but BELOW the dashboard-visibility floor (35) falls back to 35, never accepted as-is', () => {
      // Task 1.7 / finance-growth scenario 15 — the window-vs-rebuild invariant.
      expect(normalizeFinanceReceiptSyncConfig({ reconcileWindowDays: 20 }).reconcileWindowDays).toBe(35);
    });
    it('91 (above the nominal max) falls back to 35', () => {
      expect(normalizeFinanceReceiptSyncConfig({ reconcileWindowDays: 91 }).reconcileWindowDays).toBe(35);
    });
    it('a non-integer falls back to 35', () => {
      expect(normalizeFinanceReceiptSyncConfig({ reconcileWindowDays: 35.5 }).reconcileWindowDays).toBe(35);
    });
    it('exactly 35 (the floor) IS accepted', () => {
      expect(normalizeFinanceReceiptSyncConfig({ reconcileWindowDays: 35 }).reconcileWindowDays).toBe(35);
    });
    it('90 (the nominal max) IS accepted', () => {
      expect(normalizeFinanceReceiptSyncConfig({ reconcileWindowDays: 90 }).reconcileWindowDays).toBe(90);
    });
  });

  describe('reconcileCheckIntervalMs', () => {
    it('below the minimum (600000) falls back to the default (21600000)', () => {
      expect(normalizeFinanceReceiptSyncConfig({ reconcileCheckIntervalMs: 1000 }).reconcileCheckIntervalMs).toBe(21600000);
    });
    it('above the maximum (86400000) falls back to the default', () => {
      expect(normalizeFinanceReceiptSyncConfig({ reconcileCheckIntervalMs: 99999999 }).reconcileCheckIntervalMs).toBe(21600000);
    });
    it('a valid mid-range value is honored', () => {
      expect(normalizeFinanceReceiptSyncConfig({ reconcileCheckIntervalMs: 3600000 }).reconcileCheckIntervalMs).toBe(3600000);
    });
  });

  describe('annulmentGuardMaxPct — extremo peligroso es el ALTO (100 = nunca abortar)', () => {
    it('100 falls back to the default (5), NEVER accepted as-is', () => {
      expect(normalizeFinanceReceiptSyncConfig({ annulmentGuardMaxPct: 100 }).annulmentGuardMaxPct).toBe(5);
    });
    it('0 falls back to 5', () => {
      expect(normalizeFinanceReceiptSyncConfig({ annulmentGuardMaxPct: 0 }).annulmentGuardMaxPct).toBe(5);
    });
    it('a negative value falls back to 5', () => {
      expect(normalizeFinanceReceiptSyncConfig({ annulmentGuardMaxPct: -1 }).annulmentGuardMaxPct).toBe(5);
    });
    it('a valid mid-range value (e.g. 10) is honored', () => {
      expect(normalizeFinanceReceiptSyncConfig({ annulmentGuardMaxPct: 10 }).annulmentGuardMaxPct).toBe(10);
    });
    it('99 (just under the dangerous extreme) IS honored — only exactly-100-and-above is rejected via the range check', () => {
      expect(normalizeFinanceReceiptSyncConfig({ annulmentGuardMaxPct: 99 }).annulmentGuardMaxPct).toBe(99);
    });
  });

  describe('annulmentGuardMinCount', () => {
    it('0 falls back to the default (5) — a 0 floor traps the lane forever on the first annulment', () => {
      expect(normalizeFinanceReceiptSyncConfig({ annulmentGuardMinCount: 0 }).annulmentGuardMinCount).toBe(5);
    });
    it('above 1000 falls back to the default', () => {
      expect(normalizeFinanceReceiptSyncConfig({ annulmentGuardMinCount: 1001 }).annulmentGuardMinCount).toBe(5);
    });
    it('a valid value is honored', () => {
      expect(normalizeFinanceReceiptSyncConfig({ annulmentGuardMinCount: 20 }).annulmentGuardMinCount).toBe(20);
    });
  });

  it('an entirely empty object falls back to ALL defaults', () => {
    expect(normalizeFinanceReceiptSyncConfig({})).toEqual(FINANCE_RECEIPT_SYNC_CONFIG_DEFAULTS);
  });

  // ── Run against BOTH adapters — U5, design.md Testing strategy ──
  describe('applied by BOTH adapters in get() — never just one', () => {
    afterEach(() => jest.restoreAllMocks());

    it('InMemoryFinanceReceiptSyncConfigRepository normalizes reconcileWindowDays=0 on update+get', async () => {
      const repo = new InMemoryFinanceReceiptSyncConfigRepository();
      await repo.update({ reconcileWindowDays: 0 } as never);
      expect((await repo.get()).reconcileWindowDays).toBe(35);
    });

    it('InMemoryFinanceReceiptSyncConfigRepository normalizes annulmentGuardMaxPct=100 on update+get', async () => {
      const repo = new InMemoryFinanceReceiptSyncConfigRepository();
      await repo.update({ annulmentGuardMaxPct: 100 } as never);
      expect((await repo.get()).annulmentGuardMaxPct).toBe(5);
    });

    it('PrismaFinanceReceiptSyncConfigRepository normalizes a raw DB row with reconcileWindowDays=0 (a value SQL could write directly)', async () => {
      jest.spyOn(prisma.financeReceiptSyncConfig, 'findUnique').mockResolvedValue({
        id: 'singleton',
        enabled: true,
        requestIntervalMs: 20000,
        maxRequestIntervalMs: 300000,
        deltaCheckIntervalMs: 300000,
        backfillFloorYearMonth: '2013-01',
        deltaStarvationThreshold: 3,
        reconcileEnabled: true,
        reconcileWindowDays: 0,
        reconcileCheckIntervalMs: 21600000,
        annulmentGuardMaxPct: 5,
        annulmentGuardMinCount: 5,
        updatedAt: new Date(),
      } as never);

      const cfg = await new PrismaFinanceReceiptSyncConfigRepository().get();
      expect(cfg.reconcileWindowDays).toBe(35);
    });

    it('PrismaFinanceReceiptSyncConfigRepository normalizes a raw DB row with annulmentGuardMaxPct=100', async () => {
      jest.spyOn(prisma.financeReceiptSyncConfig, 'findUnique').mockResolvedValue({
        id: 'singleton',
        enabled: true,
        requestIntervalMs: 20000,
        maxRequestIntervalMs: 300000,
        deltaCheckIntervalMs: 300000,
        backfillFloorYearMonth: '2013-01',
        deltaStarvationThreshold: 3,
        reconcileEnabled: true,
        reconcileWindowDays: 35,
        reconcileCheckIntervalMs: 21600000,
        annulmentGuardMaxPct: 100,
        annulmentGuardMinCount: 5,
        updatedAt: new Date(),
      } as never);

      const cfg = await new PrismaFinanceReceiptSyncConfigRepository().get();
      expect(cfg.annulmentGuardMaxPct).toBe(5);
    });
  });
});
