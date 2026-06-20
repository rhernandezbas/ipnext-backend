/**
 * PppoeAdoption.usecases.test.ts — adopción del inventario PPPoE existente.
 *
 * Cubre los 4 use cases (in-memory only, ports puros):
 *   - IngestPppoeFromNas: crea huérfanos + skips existentes (NO clobber) + rutea por nas.type.
 *   - AssociatePppoeToContract: setea contractId / 404 / 409 si ya está en OTRO contrato.
 *   - GetPppoeCredentials: revela {username, password} / 404.
 *   - ListUnassignedPppoe: lista huérfanos (DTO sin password).
 */
import { IngestPppoeFromNas } from '@application/use-cases/IngestPppoeFromNas';
import { AssociatePppoeToContract } from '@application/use-cases/AssociatePppoeToContract';
import { GetPppoeCredentials } from '@application/use-cases/GetPppoeCredentials';
import { ListUnassignedPppoe } from '@application/use-cases/ListUnassignedPppoe';

import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';

import {
  NasNotFoundError,
  PppoeIngestNotSupportedError,
  PppoeServiceNotFoundError,
  PppoeAlreadyAssociatedError,
} from '@domain/errors/pppoe';

// NAS seed del InMemoryNasRepository: id '1' = mikrotik_api, id '3' = mikrotik_radius
const RADIUS_NAS = '3';
const MK_NAS = '1';

const INVENTORY = [
  { username: 'juanperez', password: 'pass1234', plan: 'IP-Air-30-10', framedIp: '100.64.10.10' },
  { username: 'mariam',    password: 'otra',     plan: null,           framedIp: null },
];

describe('IngestPppoeFromNas', () => {
  it('mikrotik_radius → crea PPPoE huérfanos con password/profile/remoteAddress y status enabled', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const orch = new InMemoryRadiusOrchestratorGateway({ usersInventory: INVENTORY });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch);

    const result = await uc.execute(RADIUS_NAS);

    expect(result).toEqual({ created: 2, skipped: 0, excluded: 0 });
    const juan = await repo.findByUsername('juanperez');
    expect(juan).not.toBeNull();
    expect(juan!.password).toBe('pass1234');         // password sembrado (verdad técnica)
    expect(juan!.profile).toBe('IP-Air-30-10');       // plan → profile
    expect(juan!.remoteAddress).toBe('100.64.10.10'); // framedIp → remoteAddress
    expect(juan!.contractId).toBeNull();              // HUÉRFANO
    expect(juan!.status).toBe('enabled');
    expect(juan!.nasId).toBe(RADIUS_NAS);
  });

  it('skip de usernames existentes: NO pisa una fila ya asociada', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const orch = new InMemoryRadiusOrchestratorGateway({ usersInventory: INVENTORY });
    // juanperez ya existe, asociado a un contrato, con OTRA password
    await repo.upsertByUsername({
      username: 'juanperez', password: 'NO-CLOBBER', nasId: RADIUS_NAS, contractId: 'C1', profile: 'IP-VIP',
    });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch);

    const result = await uc.execute(RADIUS_NAS);

    expect(result).toEqual({ created: 1, skipped: 1, excluded: 0 }); // mariam created, juanperez skipped
    const juan = await repo.findByUsername('juanperez');
    expect(juan!.password).toBe('NO-CLOBBER');   // ← intacto
    expect(juan!.contractId).toBe('C1');         // ← asociación intacta
    expect(juan!.profile).toBe('IP-VIP');        // ← profile intacto
  });

  it('NAS inexistente → NasNotFoundError', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const orch = new InMemoryRadiusOrchestratorGateway({ usersInventory: INVENTORY });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch);
    await expect(uc.execute('nas-99')).rejects.toBeInstanceOf(NasNotFoundError);
  });

  it('NAS no-radius (mikrotik_api) → PppoeIngestNotSupportedError', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const orch = new InMemoryRadiusOrchestratorGateway({ usersInventory: INVENTORY });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch);
    await expect(uc.execute(MK_NAS)).rejects.toBeInstanceOf(PppoeIngestNotSupportedError);
  });

  it('inventario vacío → {created:0, skipped:0, excluded:0}', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const nasRepo = new InMemoryNasRepository();
    const orch = new InMemoryRadiusOrchestratorGateway({ usersInventory: [] });
    const uc = new IngestPppoeFromNas(repo, nasRepo, orch);
    expect(await uc.execute(RADIUS_NAS)).toEqual({ created: 0, skipped: 0, excluded: 0 });
  });
});

describe('AssociatePppoeToContract', () => {
  it('setea el contractId de un PPPoE huérfano', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const orphan = await repo.upsertByUsername({ username: 'u1', password: 'p', nasId: RADIUS_NAS, contractId: null });
    const uc = new AssociatePppoeToContract(repo);

    const updated = await uc.execute(orphan.id, 'C42');

    expect(updated.contractId).toBe('C42');
    expect((await repo.findById(orphan.id))!.contractId).toBe('C42');
  });

  it('PPPoE inexistente → PppoeServiceNotFoundError', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const uc = new AssociatePppoeToContract(repo);
    await expect(uc.execute('no-existe', 'C1')).rejects.toBeInstanceOf(PppoeServiceNotFoundError);
  });

  it('ya asociado a OTRO contrato → PppoeAlreadyAssociatedError (409)', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const s = await repo.upsertByUsername({ username: 'u1', password: 'p', nasId: RADIUS_NAS, contractId: 'C1' });
    const uc = new AssociatePppoeToContract(repo);
    await expect(uc.execute(s.id, 'C2')).rejects.toBeInstanceOf(PppoeAlreadyAssociatedError);
  });

  it('re-asociar al MISMO contrato es idempotente (no lanza)', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const s = await repo.upsertByUsername({ username: 'u1', password: 'p', nasId: RADIUS_NAS, contractId: 'C1' });
    const uc = new AssociatePppoeToContract(repo);
    const updated = await uc.execute(s.id, 'C1');
    expect(updated.contractId).toBe('C1');
  });
});

describe('GetPppoeCredentials', () => {
  it('revela {username, password} de la entidad', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const s = await repo.upsertByUsername({ username: 'juanperez', password: 'pass1234', nasId: RADIUS_NAS });
    const uc = new GetPppoeCredentials(repo);
    expect(await uc.execute(s.id)).toEqual({ username: 'juanperez', password: 'pass1234' });
  });

  it('PPPoE inexistente → PppoeServiceNotFoundError', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    const uc = new GetPppoeCredentials(repo);
    await expect(uc.execute('no-existe')).rejects.toBeInstanceOf(PppoeServiceNotFoundError);
  });
});

describe('ListUnassignedPppoe', () => {
  it('devuelve solo los huérfanos (entidades; el DTO se mapea en la ruta)', async () => {
    const repo = new InMemoryPppoeServiceRepository();
    await repo.upsertByUsername({ username: 'orphan1', password: 'p', nasId: RADIUS_NAS, contractId: null });
    await repo.upsertByUsername({ username: 'asociado', password: 'p', nasId: RADIUS_NAS, contractId: 'C1' });
    const uc = new ListUnassignedPppoe(repo);
    const list = await uc.execute();
    expect(list.map(s => s.username)).toEqual(['orphan1']);
  });
});
