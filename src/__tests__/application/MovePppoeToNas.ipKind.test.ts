import { MovePppoeToNas } from '@application/use-cases/MovePppoeToNas';
import { MovePppoeServiceToRouter } from '@application/use-cases/MovePppoeServiceToRouter';
import { FindFreeIp } from '@application/use-cases/FindFreeIp';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { InMemoryNasRepository } from '@infrastructure/adapters/in-memory/InMemoryNasRepository';
import { InMemoryRadiusOrchestratorGateway } from '@infrastructure/adapters/in-memory/InMemoryRadiusOrchestratorGateway';
import { InMemoryRouterGateway } from '@infrastructure/adapters/in-memory/InMemoryRouterGateway';
import { InMemoryIpNetworkRepository } from '@infrastructure/adapters/in-memory/InMemoryIpNetworkRepository';
import { InMemoryPppoeNasMoveEventRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeNasMoveEventRepository';
import { InMemoryContractServiceEventRepository } from '@infrastructure/adapters/in-memory/InMemoryContractServiceEventRepository';
import { InMemoryServiceCatalogRepository } from '@infrastructure/adapters/in-memory/InMemoryServiceCatalogRepository';
import { NoPoolForNasTypeError } from '@domain/errors/network';
import type { NasServer } from '@domain/entities/nas';

/**
 * pppoe-move-ip-kind-aware (Fase 3) — el move resuelve la clase de IP contra el NAS DESTINO.
 *
 * Bug que motiva esto: `MovePppoeToNas` hardcodeaba `poolType='cgnat'` para todo move normal.
 * El NE8000 migró a 100% públicas en julio 2026 (0 pools cgnat / 18 public) ⇒ mover CUALQUIER
 * servicio ahí fallaba siempre con NoPoolForNasTypeError. 3272 de los 5468 servicios de la red
 * viven en ese BRAS: la operación principal estaba muerta y ningún test lo detectó, porque
 * todos ejercitaban NAS que sí tienen pools cgnat.
 *
 * Decisión del usuario (2026-07-29): al mover a un NAS que solo acepta públicas se CONVIERTE el
 * servicio (IP del pool público del destino + ipTypePreference='public'), en un solo paso.
 */

const CGNAT_IP = '100.64.90.25';   // dentro de pool-origen-cgnat (pasa el guard de IP no-CGNAT)
const FIXED_NOW = new Date('2026-07-29T12:00:00Z');

async function build() {
  const pppoeRepo   = new InMemoryPppoeServiceRepository({ now: () => FIXED_NOW });
  const nasRepo     = new InMemoryNasRepository();
  const routerGw    = new InMemoryRouterGateway();
  const netRepo     = new InMemoryIpNetworkRepository();
  const moveEvents  = new InMemoryPppoeNasMoveEventRepository({ now: () => FIXED_NOW });
  const eventRepo   = new InMemoryContractServiceEventRepository();
  const catalogRepo = new InMemoryServiceCatalogRepository();
  await catalogRepo.create({ name: 'INTERNET' });

  // El repo in-memory trae pools default: limpiarlos para controlar el escenario.
  for (const p of await netRepo.findAllPools()) await netRepo.deletePool(p.id);

  const orchestrator = new InMemoryRadiusOrchestratorGateway({ assignedIps: [CGNAT_IP] });

  const mkNas = (name: string, ip: string): Promise<NasServer> => nasRepo.createNasServer({
    name, type: 'radius_orchestrator', ipAddress: ip, radiusSecret: 'x', nasIpAddress: ip,
    apiPort: null, apiLogin: null, apiPassword: null, status: 'active', lastSeen: null,
    clientCount: 0, description: '',
  });

  const origen     = await mkNas('CANEPA (solo cgnat)', '10.0.0.10');
  const publicOnly = await mkNas('NE8000 - Mercedes (solo public)', '10.75.0.30');
  const ambos      = await mkNas('RDA Agote (cgnat + public)', '10.60.0.46');
  const cgnatOnly  = await mkNas('Ugarte (solo cgnat)', '10.60.0.14');
  const sinPools   = await mkNas('NAS nuevo sin pools', '10.0.0.99');

  const net = (id: string, cidr: string, gw: string) => netRepo.seedNetwork({
    id, network: cidr, gateway: gw, dns1: '8.8.8.8', dns2: '8.8.4.4',
    description: id, partnerId: null, type: 'pppoe', totalIps: 254, usedIps: null, freeIps: null,
  });
  const pool = (id: string, networkId: string, nasId: string, kind: 'cgnat' | 'public', a: string, b: string) =>
    netRepo.seedPool({
      id, name: id, networkId, rangeStart: a, rangeEnd: b,
      type: 'static', assignedCount: null, totalCount: 253, nasId, ipKind: kind,
    });

  net('net-origen', '100.64.90.0/24', '100.64.90.1');
  pool('pool-origen-cgnat', 'net-origen', origen.id, 'cgnat', '100.64.90.2', '100.64.90.254');

  // NE8000: SOLO público (el caso real que hoy explota)
  net('net-ne-pub', '190.7.229.64/27', '190.7.229.65');
  pool('pool-ne-public', 'net-ne-pub', publicOnly.id, 'public', '190.7.229.66', '190.7.229.94');

  // Agote: ambas clases
  net('net-agote-cg', '100.64.3.0/24', '100.64.3.1');
  pool('pool-agote-cgnat', 'net-agote-cg', ambos.id, 'cgnat', '100.64.3.2', '100.64.3.254');
  net('net-agote-pub', '190.7.238.0/24', '190.7.238.1');
  pool('pool-agote-public', 'net-agote-pub', ambos.id, 'public', '190.7.238.2', '190.7.238.254');

  // Ugarte: solo cgnat (destino del test de regresión)
  net('net-ugarte', '100.64.14.0/24', '100.64.14.1');
  pool('pool-ugarte-cgnat', 'net-ugarte', cgnatOnly.id, 'cgnat', '100.64.14.2', '100.64.14.254');

  const findFreeIp  = new FindFreeIp(netRepo, nasRepo, routerGw, orchestrator);
  const legacyMove  = new MovePppoeServiceToRouter(pppoeRepo, routerGw, nasRepo);
  const move = new MovePppoeToNas(
    pppoeRepo, nasRepo, orchestrator, findFreeIp, legacyMove, moveEvents, catalogRepo, eventRepo, netRepo,
    () => FIXED_NOW,
  );

  const svc = await pppoeRepo.createByUsername({
    username: 'EnzoBianchiCh',
    password: '1234',
    profile: 'IP-Air-30-30',
    remoteAddress: CGNAT_IP,
    ipMode: 'fixed',
    nasId: origen.id,
    contractId: null,
    ipTypePreference: 'cgnat',
  });

  return { move, pppoeRepo, moveEvents, svc, origen, publicOnly, ambos, cgnatOnly, sinPools };
}

describe('MovePppoeToNas — resolución de la clase de IP contra el destino', () => {
  // ── T3.1 REGRESIÓN: lo que YA funciona no se toca ─────────────────────────────
  it('REGRESIÓN cgnat -> cgnat: se comporta igual que antes del change', async () => {
    const { move, pppoeRepo, svc, cgnatOnly } = await build();

    const moved = await move.execute({ id: svc.id, nasId: cgnatOnly.id });

    expect(moved.nasId).toBe(cgnatOnly.id);
    expect(moved.ipTypePreference).toBe('cgnat');           // NO cambia
    expect(moved.remoteAddress).toMatch(/^100\.64\.14\./);  // del pool cgnat del DESTINO
    const after = await pppoeRepo.findById(svc.id);
    expect(after!.ipTypePreference).toBe('cgnat');
  });

  // ── T3.2 el caso que hoy explota ──────────────────────────────────────────────
  it('cgnat -> NAS public-only: CONVIERTE (IP pública del destino + preference public)', async () => {
    const { move, pppoeRepo, svc, publicOnly } = await build();

    const moved = await move.execute({ id: svc.id, nasId: publicOnly.id });

    expect(moved.nasId).toBe(publicOnly.id);
    expect(moved.ipTypePreference).toBe('public');
    expect(moved.remoteAddress).toMatch(/^190\.7\.229\./);
    const after = await pppoeRepo.findById(svc.id);
    expect(after!.ipTypePreference).toBe('public');
    expect(after!.nasId).toBe(publicOnly.id);
  });

  // ── T3.3 la IP sale del destino, NUNCA se conserva la vieja ───────────────────
  it('al convertir, la IP NO es la anterior y cae en un pool del destino', async () => {
    const { move, svc, publicOnly } = await build();

    const moved = await move.execute({ id: svc.id, nasId: publicOnly.id });

    expect(moved.remoteAddress).not.toBe(CGNAT_IP);
    const octets = moved.remoteAddress!.split('.').map(Number);
    expect(`${octets[0]}.${octets[1]}.${octets[2]}`).toBe('190.7.229');
    expect(octets[3]).toBeGreaterThanOrEqual(66);
    expect(octets[3]).toBeLessThanOrEqual(94);
  });

  it('el movimiento de conversión queda registrado en PppoeNasMoveEvent', async () => {
    const { move, moveEvents, svc, publicOnly } = await build();

    await move.execute({ id: svc.id, nasId: publicOnly.id });

    const events = await moveEvents.list({ page: 1, limit: 10 });
    expect(events.total).toBeGreaterThan(0);
  });

  // ── T3.4 destino con ambas clases -> gana la preferencia persistida ───────────
  it('destino que soporta AMBAS clases respeta el ipTypePreference persistido', async () => {
    const { move, svc, ambos } = await build();

    const moved = await move.execute({ id: svc.id, nasId: ambos.id });

    expect(moved.ipTypePreference).toBe('cgnat');            // no se toca
    expect(moved.remoteAddress).toMatch(/^100\.64\.3\./);    // pool cgnat de Agote
  });

  // ── T3.5 destino sin pools -> error tipado, NADA mutado ──────────────────────
  it('destino SIN pools: error tipado y el servicio queda intacto', async () => {
    const { move, pppoeRepo, svc, sinPools, origen } = await build();

    await expect(move.execute({ id: svc.id, nasId: sinPools.id })).rejects.toBeInstanceOf(
      NoPoolForNasTypeError,
    );

    const after = await pppoeRepo.findById(svc.id);
    expect(after!.nasId).toBe(origen.id);
    expect(after!.remoteAddress).toBe(CGNAT_IP);
    expect(after!.ipTypePreference).toBe('cgnat');
  });
});
