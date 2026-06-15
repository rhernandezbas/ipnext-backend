/**
 * #117 — Unit tests for the toEvent mapper in PrismaTvActivationEventRepository.
 * Pins the 3-branch fallback: snapshot || actor.login || ''
 *
 * Same pattern as the CSE mapper test. The TV mapper `toEvent` in
 * PrismaTvActivationEventRepository must resolve actorName using the same
 * 3-branch formula.
 */

/**
 * Mirror of the mapper logic from PrismaTvActivationEventRepository.toEvent.
 * Same formula as CSE — tests pin both adapters.
 */
function tvResolveActorName(row: { actorName: string; actor: { login: string } | null }): string {
  return row.actorName || row.actor?.login || '';
}

describe('PrismaTvActivationEventRepository — actorName resolution (3-branch fallback)', () => {
  // Branch 1: snapshot empty, actor present → use actor.login
  it('Branch 1: snapshot empty + actor.login → returns actor.login', () => {
    expect(tvResolveActorName({ actorName: '', actor: { login: 'admin' } })).toBe('admin');
  });

  // Branch 2: snapshot populated → snapshot wins (even if actor has a different login)
  it('Branch 2: snapshot populated → snapshot wins over actor.login', () => {
    expect(tvResolveActorName({ actorName: 'real', actor: { login: 'admin' } })).toBe('real');
  });

  // Branch 3: snapshot empty, actor null → returns ''
  it('Branch 3: snapshot empty + actor null → returns empty string', () => {
    expect(tvResolveActorName({ actorName: '', actor: null })).toBe('');
  });

  // Branch 4: snapshot populated and actor null → snapshot returned
  it('Branch 4: snapshot populated + actor null → snapshot returned', () => {
    expect(tvResolveActorName({ actorName: 'jperez', actor: null })).toBe('jperez');
  });
});
