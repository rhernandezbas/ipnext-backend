/**
 * ListPppoeAssignments.paginated.test.ts — TDD for paginated use case.
 *
 * Tests: execute({ page, pageSize, search?, nasId? }) returns
 *   { data: PppoeAssignmentDto[], total, page, pageSize }
 */
import { ListPppoeAssignments } from '@application/use-cases/ListPppoeAssignments';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';

const NAS_A = 'nas-a';
const NAS_B = 'nas-b';

async function seedRepo(repo: InMemoryPppoeServiceRepository) {
  // 15 assigned PPPoE services: contractId + remoteAddress + enabled
  for (let i = 1; i <= 15; i++) {
    await repo.upsertByUsername({
      username:      `user${String(i).padStart(2, '0')}`,
      password:      'secret',
      nasId:         i <= 10 ? NAS_A : NAS_B,
      contractId:    `contract-${i}`,
      remoteAddress: `10.0.0.${i}`,
      status:        'enabled',
      profile:       'plan-30',
    });
  }

  // Orphan (no contractId) — MUST NOT appear
  await repo.upsertByUsername({
    username: 'orphan', password: 'p', nasId: NAS_A,
    contractId: null, remoteAddress: '10.0.0.100', status: 'enabled',
  });

  // No IP — MUST NOT appear
  await repo.upsertByUsername({
    username: 'no-ip', password: 'p', nasId: NAS_A,
    contractId: 'c-no-ip', remoteAddress: null, status: 'enabled',
  });

  // Disabled — MUST NOT appear
  await repo.upsertByUsername({
    username: 'disabled-user', password: 'p', nasId: NAS_A,
    contractId: 'c-disabled', remoteAddress: '10.0.0.200', status: 'disabled',
  });
}

describe('ListPppoeAssignments — paginated', () => {
  let repo: InMemoryPppoeServiceRepository;
  let useCase: ListPppoeAssignments;

  beforeEach(async () => {
    repo = new InMemoryPppoeServiceRepository();
    useCase = new ListPppoeAssignments(repo);
    await seedRepo(repo);
  });

  it('page 1 with pageSize 5 returns first 5 items (alphabetical username asc)', async () => {
    const result = await useCase.execute({ page: 1, pageSize: 5 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(5);
    expect(result.total).toBe(15);
    expect(result.data).toHaveLength(5);
    // sorted by username asc: user01 … user05
    expect(result.data[0].username).toBe('user01');
    expect(result.data[4].username).toBe('user05');
  });

  it('page 2 returns next slice', async () => {
    const result = await useCase.execute({ page: 2, pageSize: 5 });
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(5);
    expect(result.total).toBe(15);
    expect(result.data).toHaveLength(5);
    expect(result.data[0].username).toBe('user06');
    expect(result.data[4].username).toBe('user10');
  });

  it('last page returns remaining items', async () => {
    const result = await useCase.execute({ page: 3, pageSize: 5 });
    expect(result.total).toBe(15);
    expect(result.data).toHaveLength(5);
    expect(result.data[0].username).toBe('user11');
  });

  it('total reflects full count, not pageSize', async () => {
    const result = await useCase.execute({ page: 1, pageSize: 3 });
    expect(result.total).toBe(15);
    expect(result.data).toHaveLength(3);
  });

  it('excludes orphans, no-IP, and disabled services', async () => {
    const result = await useCase.execute({ page: 1, pageSize: 100 });
    expect(result.total).toBe(15);
    const usernames = result.data.map(d => d.username);
    expect(usernames).not.toContain('orphan');
    expect(usernames).not.toContain('no-ip');
    expect(usernames).not.toContain('disabled-user');
  });

  it('search by username narrows results', async () => {
    const result = await useCase.execute({ page: 1, pageSize: 100, search: 'user01' });
    // user01 and user10..user15 contain '01' only partially; 'user01' exact → only 1 match
    expect(result.total).toBe(1);
    expect(result.data[0].username).toBe('user01');
  });

  it('search by IP (remoteAddress) narrows results', async () => {
    const result = await useCase.execute({ page: 1, pageSize: 100, search: '10.0.0.3' });
    // '10.0.0.3' matches 10.0.0.3 and 10.0.0.13 (both contain the string)
    expect(result.total).toBeGreaterThanOrEqual(1);
    const ips = result.data.map(d => d.ip);
    expect(ips.some(ip => ip.includes('10.0.0.3'))).toBe(true);
  });

  it('search by contractId narrows results', async () => {
    const result = await useCase.execute({ page: 1, pageSize: 100, search: 'contract-7' });
    expect(result.total).toBeGreaterThanOrEqual(1);
    const contractIds = result.data.map(d => d.contractId);
    expect(contractIds.every(c => c.includes('contract-7'))).toBe(true);
  });

  it('search is case-insensitive', async () => {
    const result = await useCase.execute({ page: 1, pageSize: 100, search: 'USER01' });
    expect(result.total).toBe(1);
    expect(result.data[0].username).toBe('user01');
  });

  it('nasId filter narrows results', async () => {
    const result = await useCase.execute({ page: 1, pageSize: 100, nasId: NAS_B });
    expect(result.total).toBe(5);  // user11..user15
    result.data.forEach(d => expect(d.nasId).toBe(NAS_B));
  });

  it('nasId + search combined narrow results', async () => {
    const result = await useCase.execute({ page: 1, pageSize: 100, nasId: NAS_B, search: 'user11' });
    expect(result.total).toBe(1);
    expect(result.data[0].username).toBe('user11');
  });

  it('no matches returns empty data with total=0', async () => {
    const result = await useCase.execute({ page: 1, pageSize: 25, search: 'zzz-nonexistent' });
    expect(result.total).toBe(0);
    expect(result.data).toHaveLength(0);
  });

  it('DTO has correct shape (ip alias, no password)', async () => {
    const result = await useCase.execute({ page: 1, pageSize: 1 });
    const dto = result.data[0];
    expect(typeof dto.id).toBe('string');
    expect(typeof dto.ip).toBe('string');
    expect(typeof dto.username).toBe('string');
    expect(typeof dto.contractId).toBe('string');
    expect(typeof dto.nasId).toBe('string');
    expect(typeof dto.status).toBe('string');
    expect(typeof dto.createdAt).toBe('string');
    expect((dto as any).password).toBeUndefined();
    expect((dto as any).remoteAddress).toBeUndefined();
  });
});
