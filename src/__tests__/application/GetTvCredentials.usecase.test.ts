/**
 * #65 fix wave H3 — GetTvCredentials: the dedicated, permission-gated surface for the TV
 * login/password. Reads them from the customer's TV ContractService row (status-agnostic, so
 * the credentials survive an inactive row — M8). Unknown customer → 404; no TV row → 404 TV_NOT_LINKED.
 */
import { GetTvCredentials } from '@application/use-cases/gigared/GetTvCredentials';
import { ClientNotFoundError } from '@domain/errors';
import { TvNotLinkedError } from '@domain/errors/gigared';

const customerLookup = (exists: boolean, tvActivationSeq = 0) =>
  ({ findById: async (id: string) => (exists ? { id, tvActivationSeq } : null) });

describe('GetTvCredentials (#65 fix wave H3)', () => {
  it('returns { login, password, internalId } from the customer TV row', async () => {
    const reader = { getByCustomer: jest.fn(async () => ({ login: 'GIGA2432', password: 'ip243200' })) };
    const uc = new GetTvCredentials(customerLookup(true), reader);
    const result = await uc.execute('cust-1');
    expect(reader.getByCustomer).toHaveBeenCalledWith('cust-1');
    // #81 — seq=0 → internalId es el Client.id pelado (identidad de hoy, back-compat).
    expect(result).toEqual({ login: 'GIGA2432', password: 'ip243200', internalId: 'cust-1' });
  });

  it('#81 — seq>0 → internalId vigente {id}-{seq} (cliente reactivado)', async () => {
    const reader = { getByCustomer: jest.fn(async () => ({ login: 'GIGA999', password: 'ip243200' })) };
    const uc = new GetTvCredentials(customerLookup(true, 2), reader);
    const result = await uc.execute('cust-1');
    expect(result.internalId).toBe('cust-1-2');
  });

  it('M8 — reads the credentials even when the row is inactive (no status filter)', async () => {
    // The reader is status-agnostic by contract; the use case just forwards whatever it returns.
    const reader = { getByCustomer: jest.fn(async () => ({ login: 'GIGA2432', password: 'ip243200' })) };
    const uc = new GetTvCredentials(customerLookup(true), reader);
    const result = await uc.execute('cust-1');
    expect(result.password).toBe('ip243200');
  });

  it('unknown customer → ClientNotFoundError', async () => {
    const reader = { getByCustomer: jest.fn(async () => null) };
    const uc = new GetTvCredentials(customerLookup(false), reader);
    await expect(uc.execute('ghost')).rejects.toBeInstanceOf(ClientNotFoundError);
    expect(reader.getByCustomer).not.toHaveBeenCalled();
  });

  it('no TV row for the customer → TvNotLinkedError (404)', async () => {
    const reader = { getByCustomer: jest.fn(async () => null) };
    const uc = new GetTvCredentials(customerLookup(true), reader);
    await expect(uc.execute('cust-1')).rejects.toBeInstanceOf(TvNotLinkedError);
  });
});
