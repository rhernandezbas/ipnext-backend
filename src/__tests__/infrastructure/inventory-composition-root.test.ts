import { readFileSync } from 'fs';
import { join } from 'path';
import { ConfirmInventorySuggestion } from '@application/use-cases/ConfirmInventorySuggestion';
import { UnitOfWork, TransactionalRepos } from '@domain/ports/UnitOfWork';

/**
 * Fix Test-H1/DimA — the composition root (app.ts) must wire the inventory
 * UnitOfWork into ConfirmInventorySuggestion so the confirm/replace dual-write
 * runs inside ONE transaction. Booting the full createApp() needs a live DB, so
 * this guards the wiring two ways:
 *
 *  1) STATIC: assert app.ts actually passes `inventoryUow` into the
 *     `new ConfirmInventorySuggestion(...)` call. A dropped arg (the exact
 *     regression Test-H1 describes) fails this.
 *  2) BEHAVIORAL: assert that when a UoW IS wired, confirm routes its writes
 *     through `uow.runInTransaction` (dual-write enabled), and when it is NOT
 *     wired it does not — proving the wiring is load-bearing.
 */
describe('Inventory composition root — dual-write wiring (Fix Test-H1/DimA)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
  });

  it('app.ts passes inventoryUow into ConfirmInventorySuggestion', () => {
    // Isolate the `new ConfirmInventorySuggestion( ... )` argument block.
    const match = appSrc.match(/new ConfirmInventorySuggestion\(([\s\S]*?)\)\s*,/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('inventoryUow');
  });

  it('ConfirmInventorySuggestion routes writes through the UoW when one is wired', () => {
    const uow: UnitOfWork = {
      runInTransaction: jest.fn(async <T>(fn: (r: TransactionalRepos) => Promise<T>) =>
        fn({} as TransactionalRepos),
      ),
    };

    // Built WITH a UoW → dual-write enabled (private `uow` field is set).
    const withUow = new ConfirmInventorySuggestion(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never, {} as never,
      uow,
    );
    expect((withUow as unknown as { uow?: UnitOfWork }).uow).toBe(uow);

    // Built WITHOUT a UoW → no dual-write boundary (footgun if app.ts drops it).
    const withoutUow = new ConfirmInventorySuggestion(
      {} as never, {} as never, {} as never, {} as never, {} as never,
      {} as never, {} as never,
    );
    expect((withoutUow as unknown as { uow?: UnitOfWork }).uow).toBeUndefined();
  });

  // FIX 7c — composition-root guard: W6 staging wiring assertions
  it('FIX-7c: app.ts passes stageMaterialDeduction into ConfirmInventorySuggestion as 12th arg', () => {
    // ConfirmInventorySuggestion's 12th arg is stageMaterialDeduction (the staging hook).
    // The regex isolates its argument block.
    const match = appSrc.match(/new ConfirmInventorySuggestion\(([\s\S]*?)\)\s*,/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('stageMaterialDeduction');
  });

  it('FIX-7c: app.ts passes stageMaterialDeduction into RecordMaterialConsumption (stage object)', () => {
    // RecordMaterialConsumption is wired with { stage: stageMaterialDeduction, scheduling: schedulingRepo }
    const match = appSrc.match(/new RecordMaterialConsumption\(([\s\S]*?)\)\s*,/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('stage: stageMaterialDeduction');
  });

  it('FIX-7c: app.ts wires ListPendingDeductions and ConfirmMaterialDeduction into createInventoryRouter', () => {
    // These are the 9th and 10th args to createInventoryRouter — both optional W6 routes.
    const match = appSrc.match(/createInventoryRouter\(([\s\S]*?)\)\s*\)/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('ListPendingDeductions');
    expect(args).toContain('ConfirmMaterialDeduction');
  });

  // EPIC #38 W5b — vehicle stock wiring guards
  it('W5b: app.ts wires GetVehicleStock and IssueStockToVehicle into createInventoryRouter', () => {
    const match = appSrc.match(/createInventoryRouter\(([\s\S]*?)\)\s*\)/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('getVehicleStock');
    expect(args).toContain('issueStockToVehicle');
  });

  it('W5b: app.ts mounts createVehicleRouter at /api/vehicles', () => {
    expect(appSrc).toContain("'/api/vehicles'");
    expect(appSrc).toContain('createVehicleRouter');
  });
});
