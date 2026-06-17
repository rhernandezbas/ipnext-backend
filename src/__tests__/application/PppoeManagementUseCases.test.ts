/**
 * pppoe-management — Update / Deactivate / Move / List use cases.
 * Misma consistencia DB↔router que Create: el router manda primero; si falla, la DB no miente.
 */
import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { DeactivatePppoeService } from '@application/use-cases/DeactivatePppoeService';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { ListPppoeByContract } from '@application/use-cases/ListPppoeByContract';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { PppoeServiceNotFoundError, RouterUnreachableError, NasNotFoundError } from '@domain/errors/pppoe';

const NAS1 = { ipAddress: '192.168.1.1', apiPort: 8728 }; // seed id '1'
const NAS3 = { ipAddress: '10.0.0.5', apiPort: 8728 };    // seed id '3' (apiPort null → 8728)

describe('PPPoE management use cases', () => {
  let repo: InMemoryPppoeServiceRepository;
  let router: InMemoryRouterGateway;
  let nasRepo: InMemoryNasRepository;

  beforeEach(() => {
    repo = new InMemoryPppoeServiceRepository();
    router = new InMemoryRouterGateway();
    nasRepo = new InMemoryNasRepository();
  });

  const seed = (over: Partial<{ username: string; contractId: string | null; status: string }> = {}) =>
    repo.upsertByUsername({ username: 'juan', password: 'p', profile: 'IP-Air-30-10', nasId: '1', contractId: 'C1', status: 'enabled', ...over });

  describe('UpdatePppoeService', () => {
    it('edita el profile en el router y en la DB', async () => {
      const s = await seed();
      await router.createSecret(NAS1, { username: 'juan', password: 'p', profile: 'IP-Air-30-10' });
      const uc = new UpdatePppoeService(repo, router, nasRepo);
      const updated = await uc.execute({ id: s.id, profile: 'IP-Air-50-50' });
      expect(updated.profile).toBe('IP-Air-50-50');
      expect((await router.listSecrets(NAS1))[0]!.profile).toBe('IP-Air-50-50');
    });

    it('router caído → la DB NO cambia', async () => {
      const s = await seed();
      const down = new InMemoryRouterGateway({ unreachable: ['192.168.1.1'] });
      const uc = new UpdatePppoeService(repo, down, nasRepo);
      await expect(uc.execute({ id: s.id, profile: 'X' })).rejects.toBeInstanceOf(RouterUnreachableError);
      expect((await repo.findById(s.id))!.profile).toBe('IP-Air-30-10');
    });

    it('inexistente → PppoeServiceNotFoundError', async () => {
      const uc = new UpdatePppoeService(repo, router, nasRepo);
      await expect(uc.execute({ id: 'nope', profile: 'X' })).rejects.toBeInstanceOf(PppoeServiceNotFoundError);
    });
  });

  describe('DeactivatePppoeService', () => {
    it('baja soft: disabled en el router + status disabled en DB', async () => {
      const s = await seed();
      await router.createSecret(NAS1, { username: 'juan', password: 'p' });
      const uc = new DeactivatePppoeService(repo, router, nasRepo);
      const r = await uc.execute(s.id);
      expect(r.status).toBe('disabled');
      expect((await router.listSecrets(NAS1))[0]!.disabled).toBe(true);
    });
  });

  describe('MovePppoeServiceToRouter', () => {
    it('move: secret en destino, fuera del origen, nasId actualizado', async () => {
      const s = await seed();
      await router.createSecret(NAS1, { username: 'juan', password: 'p', profile: 'IP-Air-30-10' });
      const uc = new MovePppoeServiceToRouter(repo, router, nasRepo);
      const r = await uc.execute({ id: s.id, nasId: '3' });
      expect(r.nasId).toBe('3');
      expect(await router.listSecrets(NAS1)).toHaveLength(0);
      expect(await router.listSecrets(NAS3)).toHaveLength(1);
    });

    it('destino caído → aborta sin cambios', async () => {
      const s = await seed();
      const down = new InMemoryRouterGateway({ unreachable: ['10.0.0.5'] });
      const uc = new MovePppoeServiceToRouter(repo, down, nasRepo);
      await expect(uc.execute({ id: s.id, nasId: '3' })).rejects.toBeInstanceOf(RouterUnreachableError);
      expect((await repo.findById(s.id))!.nasId).toBe('1');
    });

    it('nas destino inexistente → NasNotFoundError', async () => {
      const s = await seed();
      const uc = new MovePppoeServiceToRouter(repo, router, nasRepo);
      await expect(uc.execute({ id: s.id, nasId: '999' })).rejects.toBeInstanceOf(NasNotFoundError);
    });
  });

  describe('ListPppoeByContract', () => {
    it('lista los PPPoE del contrato', async () => {
      await seed({ username: 'a', contractId: 'C1' });
      await seed({ username: 'b', contractId: 'C1' });
      await seed({ username: 'c', contractId: 'C2' });
      const list = await new ListPppoeByContract(repo).execute('C1');
      expect(list.map(s => s.username).sort()).toEqual(['a', 'b']);
    });
  });
});
