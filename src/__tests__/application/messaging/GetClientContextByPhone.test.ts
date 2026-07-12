/**
 * messaging-inbox (F1, batch B4) — GetClientContextByPhone (CTX-1/CTX-2).
 * Reuses `normalizePhone`/`suffixMatch` from matchActiveClient.ts (design §4) — this
 * use case does NOT reimplement phone matching. Fakes `CustomerRepository` with only
 * `listActiveContacts()` stubbed, same "as unknown as CustomerRepository" convention
 * as `recapture.usecases.test.ts`.
 */
import { GetClientContextByPhone } from '@application/use-cases/messaging/GetClientContextByPhone';
import type { CustomerRepository, ActiveClientContact } from '@domain/ports/CustomerRepository';

function makeCustomerRepo(contacts: ActiveClientContact[]): CustomerRepository {
  return {
    listActiveContacts: jest.fn().mockResolvedValue(contacts),
  } as unknown as CustomerRepository;
}

function makeContact(overrides: Partial<ActiveClientContact> = {}): ActiveClientContact {
  return { id: 'c-default', name: 'Default Name', phone: null, email: null, ...overrides };
}

describe('GetClientContextByPhone', () => {
  it('CTX-1: a unique active client matches by phone suffix → matched', async () => {
    const contact = makeContact({ id: 'c1', name: 'Juan Perez', phone: '02324 421234' });
    const repo = makeCustomerRepo([contact]);
    const uc = new GetClientContextByPhone(repo);

    const result = await uc.execute('+54 9 2324 421234');

    expect(result).toEqual({
      status: 'matched',
      clients: [{ id: 'c1', name: 'Juan Perez', status: 'active' }],
    });
  });

  it('CTX-1: no active client matches the phone → unknown, empty clients, no throw', async () => {
    const repo = makeCustomerRepo([makeContact({ id: 'c1', phone: '444 555 6666' })]);
    const uc = new GetClientContextByPhone(repo);

    const result = await uc.execute('2324 421234');

    expect(result).toEqual({ status: 'unknown', clients: [] });
  });

  it('CTX-1: two distinct active clients match the same phone suffix → ambiguous with both candidates', async () => {
    const c2 = makeContact({ id: 'c2', name: 'Ana', phone: '02324 421234' });
    const c3 = makeContact({ id: 'c3', name: 'Beto', phone: '2324-421234' });
    const repo = makeCustomerRepo([c2, c3]);
    const uc = new GetClientContextByPhone(repo);

    const result = await uc.execute('+54 9 2324 421234');

    expect(result.status).toBe('ambiguous');
    expect(result.clients).toHaveLength(2);
    expect(result.clients).toEqual(
      expect.arrayContaining([
        { id: 'c2', name: 'Ana', status: 'active' },
        { id: 'c3', name: 'Beto', status: 'active' },
      ]),
    );
  });

  it('CTX-1: missing/garbage phone (below the significance floor) → unknown without calling the repo', async () => {
    const repo = makeCustomerRepo([makeContact({ id: 'c1', phone: '02324 421234' })]);
    const uc = new GetClientContextByPhone(repo);

    const resultNull = await uc.execute(null);
    const resultGarbage = await uc.execute('123');

    expect(resultNull).toEqual({ status: 'unknown', clients: [] });
    expect(resultGarbage).toEqual({ status: 'unknown', clients: [] });
    expect(repo.listActiveContacts).not.toHaveBeenCalled();
  });

  it('CTX-2: never mutates Client — only calls listActiveContacts (read-only), even across repeated calls', async () => {
    const contact = makeContact({ id: 'c1', name: 'Juan Perez', phone: '02324 421234' });
    const repo = makeCustomerRepo([contact]);
    const uc = new GetClientContextByPhone(repo);

    await uc.execute('2324 421234');
    await uc.execute('2324 421234');

    const repoAsRecord = repo as unknown as Record<string, unknown>;
    const mutatingMethods = ['create', 'delete', 'updateLocation'];
    for (const method of mutatingMethods) {
      expect(repoAsRecord[method]).toBeUndefined();
    }
    expect(repo.listActiveContacts).toHaveBeenCalledTimes(2);
  });
});
