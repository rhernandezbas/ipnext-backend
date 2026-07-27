import { resolvedPlanCodeAt, type LifecycleEvent } from '@application/use-cases/finance/contractLifecycle';

/**
 * finance-growth fix-wave-2 — pure unit tests for `resolvedPlanCodeAt`, the
 * function `BuildFinanceMonthlySnapshot` anchors its plan-code resolution
 * on. No dedicated test file existed for `contractLifecycle.ts` before this
 * change; `BuildFinanceMonthlySnapshot.test.ts` exercises it end-to-end, but
 * these tests isolate the rewind ALGORITHM itself from the rest of the
 * snapshot machinery (cash, attribution, bridge math) so its exact behavior
 * is independently pinned.
 */
function modified(createdAt: string, oldPlan: string, newPlan: string): LifecycleEvent {
  return { eventType: 'modified', createdAt, oldPlan, newPlan };
}
function activated(createdAt: string): LifecycleEvent {
  return { eventType: 'activated', createdAt };
}

describe('resolvedPlanCodeAt', () => {
  it('currentProfile null (no resolvable PppoeService) → always null, regardless of event history', () => {
    const events: LifecycleEvent[] = [activated('2026-01-01T00:00:00.000Z')];
    expect(resolvedPlanCodeAt(events, new Date('2026-06-01T00:00:00.000Z'), null)).toBeNull();
  });

  it('never modified: resolves to currentProfile at ANY point in time (the F2 fix — full coverage from PppoeService.profile alone)', () => {
    const events: LifecycleEvent[] = [activated('2026-01-05T00:00:00.000Z')];
    expect(resolvedPlanCodeAt(events, new Date('2026-01-10T00:00:00.000Z'), 'IP-30')).toBe('IP-30');
    expect(resolvedPlanCodeAt(events, new Date('2026-12-31T00:00:00.000Z'), 'IP-30')).toBe('IP-30');
  });

  it('one plan change: resolves to the OLD plan for a date BEFORE the change, and the NEW plan for a date AT/AFTER it', () => {
    const events: LifecycleEvent[] = [
      activated('2026-01-05T00:00:00.000Z'),
      modified('2026-04-10T00:00:00.000Z', 'IP-30', 'IP-100'),
    ];
    // currentProfile = 'IP-100' (the value AFTER the change, as PppoeService.profile is today).
    expect(resolvedPlanCodeAt(events, new Date('2026-02-01T00:00:00.000Z'), 'IP-100')).toBe('IP-30');
    expect(resolvedPlanCodeAt(events, new Date('2026-04-10T00:00:00.000Z'), 'IP-100')).toBe('IP-100'); // AT the change instant
    expect(resolvedPlanCodeAt(events, new Date('2026-05-01T00:00:00.000Z'), 'IP-100')).toBe('IP-100');
  });

  it('two plan changes: rewinds through BOTH, one at a time, to reconstruct any of the three eras', () => {
    const events: LifecycleEvent[] = [
      activated('2026-01-05T00:00:00.000Z'),
      modified('2026-03-01T00:00:00.000Z', 'IP-30', 'IP-50'),
      modified('2026-07-01T00:00:00.000Z', 'IP-50', 'IP-100'),
    ];
    expect(resolvedPlanCodeAt(events, new Date('2026-02-01T00:00:00.000Z'), 'IP-100')).toBe('IP-30');
    expect(resolvedPlanCodeAt(events, new Date('2026-05-01T00:00:00.000Z'), 'IP-100')).toBe('IP-50');
    expect(resolvedPlanCodeAt(events, new Date('2026-08-01T00:00:00.000Z'), 'IP-100')).toBe('IP-100');
  });

  it('a same-code "no-op" modified event (oldPlan === newPlan) undoes to the identical value — harmless, never breaks the rewind chain', () => {
    const events: LifecycleEvent[] = [
      activated('2026-01-05T00:00:00.000Z'),
      modified('2026-01-05T00:00:01.000Z', 'IP-30', 'IP-30'),
      modified('2026-04-10T00:00:00.000Z', 'IP-30', 'IP-100'),
    ];
    expect(resolvedPlanCodeAt(events, new Date('2026-02-01T00:00:00.000Z'), 'IP-100')).toBe('IP-30');
  });

  it('a changeKind-tagged modified event (IP/password/status audit, not a plan change) is NEVER undone as if it were a plan transition', () => {
    const events: LifecycleEvent[] = [
      activated('2026-01-05T00:00:00.000Z'),
      { eventType: 'modified', createdAt: '2026-02-01T00:00:00.000Z', changeKind: 'ip' },
    ];
    // The IP-change event must be transparent to plan resolution — currentProfile stands unchanged even at a date BEFORE it.
    expect(resolvedPlanCodeAt(events, new Date('2026-01-10T00:00:00.000Z'), 'IP-30')).toBe('IP-30');
  });

  describe('enforcement-code defensive rewind (anomalous data only — profile should never actually be an enforcement code in the normal flow)', () => {
    it('currentProfile itself is an enforcement code but an earlier modified event recorded the real commercial plan: rewinds PAST it', () => {
      const events: LifecycleEvent[] = [
        activated('2026-01-05T00:00:00.000Z'),
        modified('2026-03-10T00:00:00.000Z', 'IP-30', 'IP-REDUCCION'),
      ];
      // currentProfile = 'IP-REDUCCION' (the anomalous manual set).
      expect(resolvedPlanCodeAt(events, new Date('2026-06-01T00:00:00.000Z'), 'IP-REDUCCION')).toBe('IP-30');
    });

    it('a mid-history enforcement excursion (real plan → IP-REDUCCION → real plan restored) resolves to the real plan even for a date INSIDE the excursion window', () => {
      const events: LifecycleEvent[] = [
        activated('2026-01-05T00:00:00.000Z'),
        modified('2026-03-01T00:00:00.000Z', 'IP-30', 'IP-REDUCCION'),
        modified('2026-03-20T00:00:00.000Z', 'IP-REDUCCION', 'IP-30'),
      ];
      // currentProfile = 'IP-30' (restored). A date DURING the excursion (Mar 10) still resolves to IP-30, never the enforcement code.
      expect(resolvedPlanCodeAt(events, new Date('2026-03-10T00:00:00.000Z'), 'IP-30')).toBe('IP-30');
    });

    it('the ENTIRE resolvable history is an enforcement code with no prior commercial plan on record: returns null (honestly unpriced, never a guess)', () => {
      const events: LifecycleEvent[] = [activated('2026-01-05T00:00:00.000Z')];
      // currentProfile is itself the enforcement code, and there is no 'modified' event to rewind through at all.
      expect(resolvedPlanCodeAt(events, new Date('2026-06-01T00:00:00.000Z'), 'IP-REDUCCION')).toBeNull();
    });
  });
});
