import { ListRadiusAuthFailures } from '@application/use-cases/ListRadiusAuthFailures';
import { InMemoryRadiusAuthEventRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusAuthEventRepository';
import { RadiusAuthEventDto } from '@application/dto/radius-event.dto';
import type { RadiusAuthReply } from '@domain/entities/radius-auth-event';

function makeRepo() {
  return new InMemoryRadiusAuthEventRepository();
}

async function seedEvents(
  repo: InMemoryRadiusAuthEventRepository,
  overrides: Array<Partial<{
    username: string;
    reply: RadiusAuthReply;
    authdate: string;
    class: string | null;
  }>>,
): Promise<void> {
  await repo.upsertMany(
    overrides.map((o, i) => ({
      sourceUniqueId: `pa-${i}`,
      username:       o.username ?? `user${i}`,
      reply:          o.reply ?? 'Access-Reject',
      authdate:       new Date(o.authdate ?? `2026-06-${String(i + 1).padStart(2, '0')}T10:00:00Z`),
      class:          o.class ?? null,
    })),
  );
}

describe('ListRadiusAuthFailures', () => {
  it('sin filtros devuelve la primera página con datos (default limit=50)', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [{ username: 'c001' }, { username: 'c002' }]);
    const uc = new ListRadiusAuthFailures(repo);

    const result = await uc.execute({});

    expect(result.data).toHaveLength(2);
    expect(result.total).toBe(2);
    expect(result.page).toBe(1);
    expect(result.limit).toBe(50);
    expect(result.hasNext).toBe(false);
  });

  it('filtra por username exacto', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [{ username: 'c001' }, { username: 'c002' }, { username: 'c001' }]);
    const uc = new ListRadiusAuthFailures(repo);

    const result = await uc.execute({ username: 'c001' });

    expect(result.total).toBe(2);
    result.data.forEach((d) => expect(d.username).toBe('c001'));
  });

  it('filtra por reply', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [
      { reply: 'Access-Accept' },
      { reply: 'Access-Reject' },
      { reply: 'Access-Reject' },
    ]);
    const uc = new ListRadiusAuthFailures(repo);

    const result = await uc.execute({ reply: 'Access-Reject' });

    expect(result.total).toBe(2);
    result.data.forEach((d) => expect(d.reply).toBe('Access-Reject'));
  });

  it('filtra por rango de fechas from/to', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [
      { authdate: '2026-06-01T00:00:00Z' },
      { authdate: '2026-06-10T00:00:00Z' },
      { authdate: '2026-06-20T00:00:00Z' },
    ]);
    const uc = new ListRadiusAuthFailures(repo);

    const result = await uc.execute({ from: '2026-06-05T00:00:00Z', to: '2026-06-15T00:00:00Z' });

    expect(result.total).toBe(1);
    expect(result.data[0].authdate).toBe('2026-06-10T00:00:00.000Z');
  });

  it('pagina correctamente', async () => {
    const repo = makeRepo();
    await seedEvents(repo, Array.from({ length: 10 }, (_, i) => ({ username: `u${i}` })));
    const uc = new ListRadiusAuthFailures(repo);

    const page1 = await uc.execute({ page: 1, limit: 3 });
    const page2 = await uc.execute({ page: 2, limit: 3 });

    expect(page1.data).toHaveLength(3);
    expect(page1.total).toBe(10);
    expect(page1.hasNext).toBe(true);
    expect(page2.data).toHaveLength(3);
    expect(page2.hasNext).toBe(true);
  });

  it('limit se capea a 200', async () => {
    const repo = makeRepo();
    const uc = new ListRadiusAuthFailures(repo);
    const result = await uc.execute({ limit: 9999 });
    expect(result.limit).toBe(200);
  });

  it('resultado vacío retorna la estructura correcta', async () => {
    const repo = makeRepo();
    const uc = new ListRadiusAuthFailures(repo);

    const result = await uc.execute({});

    expect(result).toEqual({ data: [], total: 0, page: 1, limit: 50, hasNext: false });
  });

  it('sourceUniqueId no aparece en el DTO', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [{ username: 'c001' }]);
    const uc = new ListRadiusAuthFailures(repo);

    const result = await uc.execute({ username: 'c001' });
    const dto = result.data[0] as RadiusAuthEventDto;

    expect('sourceUniqueId' in dto).toBe(false);
  });

  it('ordena por authdate DESC por defecto', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [
      { authdate: '2026-06-01T00:00:00Z', username: 'early' },
      { authdate: '2026-06-20T00:00:00Z', username: 'late' },
    ]);
    const uc = new ListRadiusAuthFailures(repo);

    const result = await uc.execute({});

    expect(result.data[0].username).toBe('late');
    expect(result.data[1].username).toBe('early');
  });

  it('5 eventos, limit=2 — page1 y page2 son DISJUNTOS y orden DESC', async () => {
    const repo = makeRepo();
    await seedEvents(repo, [
      { authdate: '2026-06-03T00:00:00Z', username: 'u3' },
      { authdate: '2026-06-01T00:00:00Z', username: 'u1' },
      { authdate: '2026-06-05T00:00:00Z', username: 'u5' },
      { authdate: '2026-06-02T00:00:00Z', username: 'u2' },
      { authdate: '2026-06-04T00:00:00Z', username: 'u4' },
    ]);
    const uc = new ListRadiusAuthFailures(repo);

    const page1 = await uc.execute({ page: 1, limit: 2 });
    const page2 = await uc.execute({ page: 2, limit: 2 });
    const page3 = await uc.execute({ page: 3, limit: 2 });

    expect(page1.data.map(d => d.username)).toEqual(['u5', 'u4']);
    expect(page2.data.map(d => d.username)).toEqual(['u3', 'u2']);
    expect(page3.data.map(d => d.username)).toEqual(['u1']);

    expect(page1.hasNext).toBe(true);
    expect(page2.hasNext).toBe(true);
    expect(page3.hasNext).toBe(false);
  });
});
