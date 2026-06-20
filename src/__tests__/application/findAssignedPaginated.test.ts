/**
 * findAssignedPaginated.test.ts — unit tests for InMemoryPppoeServiceRepository.findAssignedPaginated.
 * These tests validate the port contract in isolation (no use case, no route).
 */
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';

const NAS_A = 'nas-a';
const NAS_B = 'nas-b';

async function seedRepo(repo: InMemoryPppoeServiceRepository, count = 10, nasId = NAS_A) {
  for (let i = 1; i <= count; i++) {
    await repo.upsertByUsername({
      username:      `user${String(i).padStart(2, '0')}`,
      password:      'secret',
      nasId,
      contractId:    `contract-${i}`,
      remoteAddress: `10.0.0.${i}`,
      status:        'enabled',
    });
  }
}

describe('InMemoryPppoeServiceRepository.findAssignedPaginated', () => {
  let repo: InMemoryPppoeServiceRepository;

  beforeEach(() => {
    repo = new InMemoryPppoeServiceRepository();
  });

  it('returns page 1 of pageSize with correct total', async () => {
    await seedRepo(repo, 10);
    const { data, total } = await repo.findAssignedPaginated({ page: 1, pageSize: 3 });
    expect(total).toBe(10);
    expect(data).toHaveLength(3);
    expect(data[0].username).toBe('user01');
    expect(data[2].username).toBe('user03');
  });

  it('page 2 returns next slice', async () => {
    await seedRepo(repo, 10);
    const { data, total } = await repo.findAssignedPaginated({ page: 2, pageSize: 3 });
    expect(total).toBe(10);
    expect(data).toHaveLength(3);
    expect(data[0].username).toBe('user04');
  });

  it('total is full count, not page size', async () => {
    await seedRepo(repo, 10);
    const { total, data } = await repo.findAssignedPaginated({ page: 1, pageSize: 3 });
    expect(total).toBe(10);
    expect(data.length).toBeLessThan(total);
  });

  it('excludes orphans (contractId=null)', async () => {
    await seedRepo(repo, 3);
    await repo.upsertByUsername({
      username: 'orphan', password: 'p', nasId: NAS_A,
      contractId: null, remoteAddress: '10.0.0.99', status: 'enabled',
    });
    const { total } = await repo.findAssignedPaginated({ page: 1, pageSize: 100 });
    expect(total).toBe(3);
  });

  it('excludes no-IP (remoteAddress=null)', async () => {
    await seedRepo(repo, 3);
    await repo.upsertByUsername({
      username: 'no-ip', password: 'p', nasId: NAS_A,
      contractId: 'cX', remoteAddress: null, status: 'enabled',
    });
    const { total } = await repo.findAssignedPaginated({ page: 1, pageSize: 100 });
    expect(total).toBe(3);
  });

  it('excludes disabled services', async () => {
    await seedRepo(repo, 3);
    await repo.upsertByUsername({
      username: 'disabled', password: 'p', nasId: NAS_A,
      contractId: 'cD', remoteAddress: '10.0.0.99', status: 'disabled',
    });
    const { total } = await repo.findAssignedPaginated({ page: 1, pageSize: 100 });
    expect(total).toBe(3);
  });

  it('search by username filters (case-insensitive)', async () => {
    await seedRepo(repo, 5);
    const { data, total } = await repo.findAssignedPaginated({ page: 1, pageSize: 100, search: 'USER01' });
    expect(total).toBe(1);
    expect(data[0].username).toBe('user01');
  });

  it('search by remoteAddress (IP) filters', async () => {
    await seedRepo(repo, 5);
    const { data, total } = await repo.findAssignedPaginated({ page: 1, pageSize: 100, search: '10.0.0.3' });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(data.every(d => d.remoteAddress?.includes('10.0.0.3'))).toBe(true);
  });

  it('search by contractId filters', async () => {
    await seedRepo(repo, 5);
    const { data, total } = await repo.findAssignedPaginated({ page: 1, pageSize: 100, search: 'contract-2' });
    expect(total).toBeGreaterThanOrEqual(1);
    expect(data.every(d => d.contractId?.includes('contract-2'))).toBe(true);
  });

  it('nasId filter narrows to that NAS only', async () => {
    await seedRepo(repo, 5, NAS_A);
    await seedRepo(repo, 3, NAS_B);  // username conflict check — needs different names
    // Re-seed NAS_B with different usernames since upsertByUsername is idempotent
    // Clear and seed both
    const repo2 = new InMemoryPppoeServiceRepository();
    for (let i = 1; i <= 5; i++) {
      await repo2.upsertByUsername({
        username: `nas-a-user${i}`, password: 'p', nasId: NAS_A,
        contractId: `ca${i}`, remoteAddress: `10.0.0.${i}`, status: 'enabled',
      });
    }
    for (let i = 1; i <= 3; i++) {
      await repo2.upsertByUsername({
        username: `nas-b-user${i}`, password: 'p', nasId: NAS_B,
        contractId: `cb${i}`, remoteAddress: `10.1.0.${i}`, status: 'enabled',
      });
    }
    const { data, total } = await repo2.findAssignedPaginated({ page: 1, pageSize: 100, nasId: NAS_B });
    expect(total).toBe(3);
    data.forEach(d => expect(d.nasId).toBe(NAS_B));
  });

  it('stable order is username asc', async () => {
    // Insert in reverse order
    for (let i = 5; i >= 1; i--) {
      await repo.upsertByUsername({
        username: `zuser${i}`, password: 'p', nasId: NAS_A,
        contractId: `c${i}`, remoteAddress: `10.0.0.${i}`, status: 'enabled',
      });
    }
    const { data } = await repo.findAssignedPaginated({ page: 1, pageSize: 10 });
    expect(data[0].username).toBe('zuser1');
    expect(data[4].username).toBe('zuser5');
  });

  it('empty result when no assigned services exist', async () => {
    const { data, total } = await repo.findAssignedPaginated({ page: 1, pageSize: 25 });
    expect(total).toBe(0);
    expect(data).toHaveLength(0);
  });
});
