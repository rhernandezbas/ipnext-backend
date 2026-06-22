import { nextStatus } from '@domain/entities/inventory-asset';
import { InvalidStatusTransitionError } from '@domain/errors/inventory';

describe('inventory-asset nextStatus (state machine)', () => {
  it('removed → available is legal (revive: refurbish back to stock)', () => {
    expect(nextStatus('removed', 'available')).toBe('available');
  });

  it('removed → available → installed (the two-step revive path)', () => {
    expect(nextStatus('removed', 'available')).toBe('available');
    expect(nextStatus('available', 'installed')).toBe('installed');
  });

  it('removed → installed directly is still ILLEGAL (must pass through available)', () => {
    expect(() => nextStatus('removed', 'installed')).toThrow(InvalidStatusTransitionError);
  });

  it('from === to is a no-op (idempotent)', () => {
    expect(nextStatus('removed', 'removed')).toBe('removed');
  });

  it('damaged → installed is ILLEGAL (a damaged asset cannot be revived)', () => {
    expect(() => nextStatus('damaged', 'installed')).toThrow(InvalidStatusTransitionError);
  });

  it('retired → installed is ILLEGAL (retired is terminal)', () => {
    expect(() => nextStatus('retired', 'installed')).toThrow(InvalidStatusTransitionError);
  });
});
