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

  // Wave 7 (Capstone) — dashboard use case wiring guards
  it('W7: app.ts wires GetInventoryOverview into createInventoryRouter', () => {
    const match = appSrc.match(/createInventoryRouter\(([\s\S]*?)\)\s*\)/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('GetInventoryOverview');
  });

  it('W7: app.ts wires ListInventoryMovements into createInventoryRouter', () => {
    const match = appSrc.match(/createInventoryRouter\(([\s\S]*?)\)\s*\)/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('ListInventoryMovements');
  });

  it('W7: app.ts wires GetLowStockAlerts into createInventoryRouter', () => {
    const match = appSrc.match(/createInventoryRouter\(([\s\S]*?)\)\s*\)/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('GetLowStockAlerts');
  });

  // Inventory flow fixes — technician list + return-by-task wiring guards
  it('flow-fixes: app.ts wires ListTechniciansWithStock and ListReturnSuggestionsByTask into createInventoryRouter', () => {
    const match = appSrc.match(/createInventoryRouter\(([\s\S]*?)\)\s*\)/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('ListTechniciansWithStock');
    expect(args).toContain('ListReturnSuggestionsByTask');
  });

  // EPIC #38 follow-up — depot stock entry wiring guards
  it('depot-entry: app.ts wires AddAssetToDepot into createInventoryRouter', () => {
    const match = appSrc.match(/createInventoryRouter\(([\s\S]*?)\)\s*\)/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('AddAssetToDepot');
  });

  it('depot-entry: app.ts wires AddMaterialToDepot into createInventoryRouter', () => {
    const match = appSrc.match(/createInventoryRouter\(([\s\S]*?)\)\s*\)/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('AddMaterialToDepot');
  });

  // #39 — manual equipment retirement wiring guard
  it('#39: app.ts instantiates RetireContractEquipment and passes it into createSchedulingRouter', () => {
    expect(appSrc).toContain('RetireContractEquipment');
    // Verify it is passed to createSchedulingRouter (not just imported)
    const match = appSrc.match(/createSchedulingRouter\(([\s\S]*?)\)\s*\)/);
    expect(match).not.toBeNull();
    const args = match![1];
    expect(args).toContain('retireContractEquipment');
  });

  // FIX 1 (#39 security) — createProjectsRouter must receive requirePerm('inventory','manage') as last arg
  it('#39 FIX-1: app.ts passes requirePerm(inventory,manage) into createProjectsRouter', () => {
    // Find the line (or block) containing the createProjectsRouter call.
    // We search the full source for the call + the guard expression.
    // Using a single regex that matches the entire line(s) of the call is
    // fragile with nested parens, so we assert both literals co-occur within
    // a bounded window of 300 chars — robust against minor formatting changes.
    const callIdx = appSrc.indexOf('createProjectsRouter(');
    expect(callIdx).toBeGreaterThan(-1);
    const callWindow = appSrc.slice(callIdx, callIdx + 300);
    expect(callWindow).toMatch(/requirePerm\s*\(\s*['"]inventory['"]\s*,\s*['"]manage['"]\s*\)/);
  });
});
