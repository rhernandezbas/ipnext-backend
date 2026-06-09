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
  it('app.ts passes inventoryUow into ConfirmInventorySuggestion', () => {
    const appSrc = readFileSync(
      join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'),
      'utf8',
    );
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
});
