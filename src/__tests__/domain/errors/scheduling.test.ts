import { ReferenceNotFoundError } from '../../../domain/errors/scheduling';

describe('ReferenceNotFoundError', () => {
  it('sets kind and id properties', () => {
    const err = new ReferenceNotFoundError('customer', 'cust-123');
    expect(err.kind).toBe('customer');
    expect(err.id).toBe('cust-123');
  });

  it('formats message as "kind not found: id"', () => {
    const err = new ReferenceNotFoundError('service', 'svc-99');
    expect(err.message).toBe('service not found: svc-99');
  });

  it('sets name to ReferenceNotFoundError', () => {
    const err = new ReferenceNotFoundError('watcher', 'w-1');
    expect(err.name).toBe('ReferenceNotFoundError');
  });

  it('is an instance of Error', () => {
    expect(new ReferenceNotFoundError('assignee', 'a-1')).toBeInstanceOf(Error);
  });

  it.each([
    'customer', 'service', 'partner', 'reporter', 'assignee', 'watcher',
  ] as const)('accepts kind "%s"', (kind) => {
    const err = new ReferenceNotFoundError(kind, 'id-1');
    expect(err.kind).toBe(kind);
  });
});
