import { describe, it, expect } from '@jest/globals';
import { TaskAutocompleteScheduler } from '@infrastructure/scheduling/TaskAutocompleteScheduler';

const opts = { intervalMs: 1000, silent: true };

function lockStub(acquired = true) {
  return { tryAcquire: async () => acquired, release: async () => {} } as never;
}
function reprocessStub(result: unknown) {
  return { execute: async () => result } as never;
}

describe('TaskAutocompleteScheduler', () => {
  it('skips when the flag is off (reprocess returns skipped)', async () => {
    const s = new TaskAutocompleteScheduler(reprocessStub({ skipped: true }), opts, lockStub(true));
    expect(await s.runOnce()).toMatchObject({ skipped: true });
  });

  it('skips when the lock is held by another instance', async () => {
    const s = new TaskAutocompleteScheduler(reprocessStub({ skipped: false, processed: 5 }), opts, lockStub(false));
    expect(await s.runOnce()).toMatchObject({ skipped: true });
  });

  it('runs the reprocess when the flag is on', async () => {
    const s = new TaskAutocompleteScheduler(
      reprocessStub({ skipped: false, processed: 2, candidates: 3, noTask: 0 }),
      opts,
      lockStub(true),
    );
    expect(await s.runOnce()).toMatchObject({ processed: 2 });
  });
});
