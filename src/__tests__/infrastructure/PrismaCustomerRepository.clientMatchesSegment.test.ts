/**
 * portal-promos — paridad OBLIGATORIA entre `listSegmentRecipients` (¿quiénes
 * son del segmento?, usado por `audience-preview`/operador) y
 * `clientMatchesSegment` (¿ESTE cliente es del segmento?, usado por
 * `GET /api/portal/promos` para gatear lo que ve el cliente). Si estos dos
 * caminos se arman por separado, el operador ve "llega a 87" y le llega a
 * otra gente EN SILENCIO — la clase de bug más cara de este change.
 *
 * NO hay Postgres de dev alcanzable (regla CLAUDE.md) — mismo patrón que
 * `PrismaCustomerRepository.list.segment.test.ts`: `buildSegmentWhere` y
 * `buildClientMatchesSegmentWhere` son funciones PURAS, testeadas sin
 * Prisma/DB. La garantía anti-divergencia es ESTRUCTURAL:
 * `buildClientMatchesSegmentWhere` literalmente hace
 * `{ ...buildSegmentWhere(segment), id: clientId }` — nunca reimplementa el
 * armado del WHERE. Este archivo prueba DOS cosas:
 *
 *   1. Pin estructural: `buildClientMatchesSegmentWhere` embebe EXACTAMENTE
 *      lo que devuelve `buildSegmentWhere` para el mismo segmento (si algún
 *      día alguien lo reescribe "a mano" en vez de spreadear, este test se
 *      pone rojo).
 *   2. Paridad de CONJUNTOS sobre un fixture multi-eje (estado + nodo + deuda
 *      a la vez, con ≥1 cliente que falla por CADA eje por separado): el
 *      conjunto de clientes que el WHERE de `listSegmentRecipients` matchea
 *      es EXACTAMENTE el conjunto de clientes para los que el WHERE de
 *      `clientMatchesSegment` da `true` — evaluados con el MISMO intérprete
 *      (`evaluateWhere`), para que la única diferencia entre ambos caminos
 *      sea la que la producción realmente tiene: el `id: clientId` extra.
 */
import { buildSegmentWhere, buildClientMatchesSegmentWhere } from '../../infrastructure/adapters/prisma/PrismaCustomerRepository';
import type { CampaignSegmentFilter } from '../../domain/ports/CustomerRepository';

// ── Intérprete mínimo del WHERE que buildSegmentWhere puede producir ─────────
// Cubre exactamente las formas usadas hoy: status.in, balanceDue.{gte,lte},
// balanceDue:null, OR:[...], contracts.some.{networkSiteId,accessPointId,NOT},
// e `id` (igualdad simple). No es un intérprete de Prisma genérico — a
// propósito: si `buildSegmentWhere` empieza a emitir una forma nueva, este
// test debe fallar por "shape no soportada" en vez de mentir un resultado.
interface FixtureContract {
  networkSiteId: string | null;
  accessPointId: string | null;
  status: string;
}
interface FixtureClient {
  id: string;
  status: string;
  balanceDue: number | null;
  contracts: FixtureContract[];
}

function evaluateBalanceRange(range: { gte?: number; lte?: number }, balanceDue: number | null): boolean {
  if (balanceDue === null) return false; // Prisma: comparaciones contra NULL nunca matchean
  if (range.gte !== undefined && balanceDue < range.gte) return false;
  if (range.lte !== undefined && balanceDue > range.lte) return false;
  return true;
}

function evaluateContractsSome(some: Record<string, unknown>, contracts: FixtureContract[]): boolean {
  return contracts.some((c) => {
    if (some['networkSiteId'] !== undefined && c.networkSiteId !== some['networkSiteId']) return false;
    if (some['accessPointId'] !== undefined && c.accessPointId !== some['accessPointId']) return false;
    const not = some['NOT'] as { status?: { equals?: string; mode?: string } } | undefined;
    if (not?.status?.equals) {
      if (c.status.toLowerCase() === not.status.equals.toLowerCase()) return false;
    }
    return true;
  });
}

function evaluateClause(clause: Record<string, unknown>, client: FixtureClient): boolean {
  for (const [key, value] of Object.entries(clause)) {
    if (key === 'id') {
      if (client.id !== value) return false;
      continue;
    }
    if (key === 'status') {
      const { in: statuses } = value as { in: string[] };
      if (!statuses.includes(client.status)) return false;
      continue;
    }
    if (key === 'balanceDue') {
      if (value === null) {
        if (client.balanceDue !== null) return false;
      } else if (!evaluateBalanceRange(value as { gte?: number; lte?: number }, client.balanceDue)) {
        return false;
      }
      continue;
    }
    if (key === 'OR') {
      const branches = value as Record<string, unknown>[];
      if (!branches.some((branch) => evaluateClause(branch, client))) return false;
      continue;
    }
    if (key === 'contracts') {
      const some = (value as { some: Record<string, unknown> }).some;
      if (!evaluateContractsSome(some, client.contracts)) return false;
      continue;
    }
    throw new Error(`shape no soportada por el intérprete de test: "${key}"`);
  }
  return true;
}

function listByWhere(clients: FixtureClient[], where: Record<string, unknown>): string[] {
  return clients.filter((c) => evaluateClause(where, c)).map((c) => c.id);
}

function matchesByWhere(client: FixtureClient, where: Record<string, unknown>): boolean {
  return evaluateClause(where, client);
}

describe('buildClientMatchesSegmentWhere — pin estructural (SIN Prisma/DB)', () => {
  const segments: CampaignSegmentFilter[] = [
    { statuses: ['late', 'blocked'] },
    { statuses: [], balanceMin: 1000, balanceMax: 50000 },
    { statuses: ['active'], networkSiteId: 'ns-1', accessPointId: 'ap-9' },
    { statuses: ['late'], balanceMin: 0, networkSiteId: 'ns-1' },
  ];

  it.each(segments)('embebe EXACTAMENTE buildSegmentWhere(segment) + id — segmento %j', (segment) => {
    const clientId = 'client-pin-1';
    expect(buildClientMatchesSegmentWhere(clientId, segment)).toEqual({
      ...buildSegmentWhere(segment),
      id: clientId,
    });
  });
});

describe('paridad listSegmentRecipients <-> clientMatchesSegment — fixture multi-eje (estado + nodo + deuda)', () => {
  // Segmento combinado: status ∈ {active, late}, balanceDue >= 1000, nodo ns-1.
  const segment: CampaignSegmentFilter = { statuses: ['active', 'late'], balanceMin: 1000, networkSiteId: 'ns-1' };

  const clients: FixtureClient[] = [
    // c1 — matchea los 3 ejes.
    { id: 'c1', status: 'active', balanceDue: 5000, contracts: [{ networkSiteId: 'ns-1', accessPointId: null, status: 'active' }] },
    // c2 — falla por ESTADO (blocked no está en statuses).
    { id: 'c2', status: 'blocked', balanceDue: 5000, contracts: [{ networkSiteId: 'ns-1', accessPointId: null, status: 'active' }] },
    // c3 — falla por DEUDA (balance por debajo del piso).
    { id: 'c3', status: 'active', balanceDue: 500, contracts: [{ networkSiteId: 'ns-1', accessPointId: null, status: 'active' }] },
    // c4 — falla por NODO (contrato en otro nodo).
    { id: 'c4', status: 'late', balanceDue: 2000, contracts: [{ networkSiteId: 'ns-2', accessPointId: null, status: 'active' }] },
    // c5 — falla por DEUDA null (FIX-12: piso>0 excluye los never-synced).
    { id: 'c5', status: 'active', balanceDue: null, contracts: [{ networkSiteId: 'ns-1', accessPointId: null, status: 'active' }] },
    // c6 — falla por NODO/baja (H1: el ÚNICO contrato del nodo está de baja).
    { id: 'c6', status: 'active', balanceDue: 10000, contracts: [{ networkSiteId: 'ns-1', accessPointId: null, status: 'baja' }] },
    // c7 — matchea vía un SEGUNDO contrato (el de baja en ns-2 no cuenta, el activo en ns-1 sí).
    {
      id: 'c7',
      status: 'late',
      balanceDue: 3000,
      contracts: [
        { networkSiteId: 'ns-2', accessPointId: null, status: 'baja' },
        { networkSiteId: 'ns-1', accessPointId: null, status: 'active' },
      ],
    },
    // c8 — boundary: balanceDue == balanceMin exacto, debe matchear (gte inclusive).
    { id: 'c8', status: 'active', balanceDue: 1000, contracts: [{ networkSiteId: 'ns-1', accessPointId: null, status: 'active' }] },
  ];

  it('el conjunto de listSegmentRecipients (vía buildSegmentWhere) es EXACTAMENTE el de {c: clientMatchesSegment(c)===true}', () => {
    const where = buildSegmentWhere(segment);
    const listedIds = new Set(listByWhere(clients, where));

    // Ancla — si el fixture no ejercita los 3 ejes de exclusión, el test no prueba nada.
    expect([...listedIds].sort()).toEqual(['c1', 'c7', 'c8']);

    const matchedIds = new Set(
      clients.filter((c) => matchesByWhere(c, buildClientMatchesSegmentWhere(c.id, segment))).map((c) => c.id),
    );

    expect(matchedIds).toEqual(listedIds);
  });

  // Revert-probe (documentado en el reporte): si `buildClientMatchesSegmentWhere`
  // dejara de agregar `NOT baja` (p.ej. un WHERE construido a mano que se
  // olvida del `some.NOT`), c6 pasaría a matchear y este test se pondría rojo
  // — confirmado manualmente reescribiendo la función sin el spread durante el
  // desarrollo (ver reporte).
  it('cada cliente individual responde lo mismo que su pertenencia al conjunto listado', () => {
    const where = buildSegmentWhere(segment);
    const listedIds = new Set(listByWhere(clients, where));
    for (const client of clients) {
      const matches = matchesByWhere(client, buildClientMatchesSegmentWhere(client.id, segment));
      expect(matches).toBe(listedIds.has(client.id));
    }
  });
});
