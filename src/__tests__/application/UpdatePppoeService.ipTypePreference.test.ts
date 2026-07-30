import { UpdatePppoeService } from '@application/use-cases/UpdatePppoeService';
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { UpdatePppoeBodySchema } from '@application/dto/pppoe.dto';
import { PppoePendingInstallError } from '@domain/errors/pppoe';
import { NoPoolForNasTypeError } from '@domain/errors/network';

/**
 * pppoe-move-ip-kind-aware (Fase 4 + ampliación) — el `ipTypePreference` se PERSISTE, y la
 * consistencia IP↔clase se garantiza según haya NAS o no.
 *
 * Bug base: el `updateBody` del FE (`InternetPanel.tsx:824`) solo llevaba `password` y
 * `remoteAddress`; el toggle Privada/Pública nunca salía al backend.
 *
 * REGLA DEL USUARIO (2026-07-29), que evita el estado inconsistente tipo `SantiagoGaleanoRo`
 * (marcado 'public' con IP CGNAT viva):
 *   - SIN NAS (pendiente de instalación): la clase es una INTENCIÓN a futuro; se permite
 *     cambiarla sola, porque la IP concreta la resuelve la adopción. Excepción acotada al
 *     guard `PppoePendingInstallError` (metadata local: no toca router ni necesita NAS).
 *   - CON NAS: hay una IP VIVA. Cambiar la clase sin dar IP nueva dejaría el servicio
 *     descolgado ⇒ el backend AUTO-ASIGNA una del pool de la clase nueva del propio NAS.
 */

const CGNAT_IP = '100.64.3.50';

async function build(opts?: { pending?: boolean; nasPools?: Array<'cgnat' | 'public'> }) {
  const repo    = new InMemoryPppoeServiceRepository();
  const nasRepo = new InMemoryNasRepository();
  const router  = new InMemoryRouterGateway();
  const orch    = new InMemoryRadiusOrchestratorGateway({ assignedIps: [CGNAT_IP] });
  const netRepo = new InMemoryIpNetworkRepository();
  for (const p of await netRepo.findAllPools()) await netRepo.deletePool(p.id);

  const nas = await nasRepo.createNasServer({
    name: 'RDA Agote', type: 'radius_orchestrator', ipAddress: '10.60.0.46',
    radiusSecret: 'x', nasIpAddress: '10.60.0.46', apiPort: null, apiLogin: null,
    apiPassword: null, status: 'active', lastSeen: null, clientCount: 0, description: '',
  });

  const kinds = opts?.nasPools ?? ['cgnat', 'public'];
  if (kinds.includes('cgnat')) {
    netRepo.seedNetwork({
      id: 'net-cg', network: '100.64.3.0/24', gateway: '100.64.3.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
      description: 'cg', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
    });
    netRepo.seedPool({
      id: 'pool-cg', name: 'cgnat-agote', networkId: 'net-cg',
      rangeStart: '100.64.3.2', rangeEnd: '100.64.3.254',
      type: 'static', assignedCount: null, totalCount: 253, nasId: nas.id, ipKind: 'cgnat',
    });
  }
  if (kinds.includes('public')) {
    netRepo.seedNetwork({
      id: 'net-pub', network: '190.7.238.0/24', gateway: '190.7.238.1', dns1: '8.8.8.8', dns2: '8.8.4.4',
      description: 'pub', partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
    });
    netRepo.seedPool({
      id: 'pool-pub', name: 'public-agote', networkId: 'net-pub',
      rangeStart: '190.7.238.2', rangeEnd: '190.7.238.254',
      type: 'static', assignedCount: null, totalCount: 253, nasId: nas.id, ipKind: 'public',
    });
  }

  const svc = await repo.createByUsername({
    username: 'TestUser', password: '1234', profile: 'IP-Air-30-30',
    remoteAddress: opts?.pending ? null : CGNAT_IP,
    ipMode: 'fixed',
    nasId: opts?.pending ? null : nas.id,
    contractId: null, ipTypePreference: 'cgnat',
  });

  const findFreeIp = new FindFreeIp(netRepo, nasRepo, router, orch);
  const uc = new UpdatePppoeService(repo, router, nasRepo, orch, undefined, undefined, findFreeIp);
  return { uc, repo, svc, nas };
}

describe('UpdatePppoeService — ipTypePreference con NAS', () => {
  it('persiste la clase cuando el operador tambien manda la IP nueva (flujo del modal)', async () => {
    const { uc, repo, svc } = await build();

    await uc.execute({ id: svc.id, ipTypePreference: 'public', remoteAddress: '190.7.238.20' });

    const after = await repo.findById(svc.id);
    expect(after!.ipTypePreference).toBe('public');
    expect(after!.remoteAddress).toBe('190.7.238.20');   // gana la del operador
  });

  it('AUTO-ASIGNA una IP del pool de la clase nueva si el operador no la manda', async () => {
    const { uc, repo, svc } = await build();

    await uc.execute({ id: svc.id, ipTypePreference: 'public' });

    const after = await repo.findById(svc.id);
    expect(after!.ipTypePreference).toBe('public');
    // NO quedo con la CGNAT vieja: el estado inconsistente que el usuario NO quiere.
    expect(after!.remoteAddress).not.toBe(CGNAT_IP);
    expect(after!.remoteAddress).toMatch(/^190\.7\.238\./);
  });

  it('NO auto-asigna nada si la clase no cambia (sin cambios de IP espurios)', async () => {
    const { uc, repo, svc } = await build();

    await uc.execute({ id: svc.id, ipTypePreference: 'cgnat' });

    const after = await repo.findById(svc.id);
    expect(after!.remoteAddress).toBe(CGNAT_IP);   // intacta
  });

  it('NO toca la clase cuando el input no la trae', async () => {
    const { uc, repo, svc } = await build();

    await uc.execute({ id: svc.id, password: 'nueva-clave' });

    const after = await repo.findById(svc.id);
    expect(after!.ipTypePreference).toBe('cgnat');
    expect(after!.remoteAddress).toBe(CGNAT_IP);
  });

  it('el NAS no tiene pool de la clase nueva -> error tipado, servicio intacto', async () => {
    const { uc, repo, svc } = await build({ nasPools: ['cgnat'] });

    await expect(uc.execute({ id: svc.id, ipTypePreference: 'public' })).rejects.toBeInstanceOf(
      NoPoolForNasTypeError,
    );

    const after = await repo.findById(svc.id);
    expect(after!.ipTypePreference).toBe('cgnat');
    expect(after!.remoteAddress).toBe(CGNAT_IP);
  });
});

describe('UpdatePppoeService — ipTypePreference en un PENDIENTE (sin NAS)', () => {
  it('permite cambiar SOLO la clase (intencion a futuro; la IP la resuelve la adopcion)', async () => {
    const { uc, repo, svc } = await build({ pending: true });

    await uc.execute({ id: svc.id, ipTypePreference: 'public' });

    const after = await repo.findById(svc.id);
    expect(after!.ipTypePreference).toBe('public');
    expect(after!.nasId).toBeNull();          // sigue pendiente
    expect(after!.remoteAddress).toBeNull();  // sin IP, como corresponde
  });

  it('sigue rechazando cualquier OTRO campo en un pendiente (guard intacto)', async () => {
    const { uc, svc } = await build({ pending: true });

    await expect(uc.execute({ id: svc.id, password: 'x' })).rejects.toBeInstanceOf(
      PppoePendingInstallError,
    );
    await expect(
      uc.execute({ id: svc.id, ipTypePreference: 'public', password: 'x' }),
    ).rejects.toBeInstanceOf(PppoePendingInstallError);
  });
});

describe('UpdatePppoeBodySchema — ipTypePreference', () => {
  it('acepta cgnat y public', () => {
    expect(UpdatePppoeBodySchema.safeParse({ ipTypePreference: 'cgnat' }).success).toBe(true);
    expect(UpdatePppoeBodySchema.safeParse({ ipTypePreference: 'public' }).success).toBe(true);
  });

  it('rechaza un valor invalido (-> 422 en la ruta)', () => {
    expect(UpdatePppoeBodySchema.safeParse({ ipTypePreference: 'privada' }).success).toBe(false);
    expect(UpdatePppoeBodySchema.safeParse({ ipTypePreference: '' }).success).toBe(false);
  });

  it('sigue aceptando un body sin el campo (no es obligatorio)', () => {
    expect(UpdatePppoeBodySchema.safeParse({ password: 'x' }).success).toBe(true);
  });
});
