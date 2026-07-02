/**
 * ListRadiusSessionsPaginated.test.ts
 *
 * TDD: red → green → refactor.
 * Cubre las tasks 2.1–2.7 (filtros + paginado + stats en el use case).
 *
 * Strict TDD Mode: este archivo se escribe ANTES de implementar los cambios en ListRadiusSessions.
 * Los tests deben fallar inicialmente.
 */
import { InMemoryRadiusSessionRepository } from '@infrastructure/adapters/in-memory/InMemoryRadiusSessionRepository';
import { InMemoryPppoeServiceRepository } from '@infrastructure/adapters/in-memory/InMemoryPppoeServiceRepository';
import { ListRadiusSessions } from '@application/use-cases/ListRadiusSessions';
import { RadiusSession } from '@domain/entities/radiusSessions';
import { RadiusSessionRepository } from '@domain/ports/RadiusSessionRepository';
import { PaginatedRadiusSessionsDto } from '@application/dto/radius-session.dto';

/** Stub configurable para controlar exactamente qué sesiones existen. */
class StubRepo implements RadiusSessionRepository {
  constructor(private readonly sessions: RadiusSession[]) {}
  async listSessions(): Promise<RadiusSession[]> { return [...this.sessions]; }
  async disconnectSession(): Promise<{ success: boolean }> { return { success: true }; }
}

function makeSession(overrides: Partial<RadiusSession> & { id: string; username: string }): RadiusSession {
  return {
    sessionId: `ACCT-${overrides.id}`,
    clientName: 'Cliente Test',
    nasId: 'nas-1',
    nasName: 'NAS Central',
    ipAddress: '10.0.0.1',
    macAddress: 'AA:BB:CC:DD:EE:01',
    startedAt: '2026-04-28T07:00:00Z',
    duration: 3600,
    downloadBytes: 1000000,
    uploadBytes: 500000,
    downloadMbps: 10,
    uploadMbps: 2,
    status: 'active',
    contractId: null,
    clientId: null,
    customerName: null,
    ...overrides,
  };
}

// ── 2.1 Back-compat: execute() sin params → RadiusSession[] ──────────────────

describe('ListRadiusSessions — 2.1 back-compat sin params', () => {
  it('execute() sin params devuelve array RadiusSession[] (no envelope)', async () => {
    const repo = new InMemoryRadiusSessionRepository();
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());

    const result = await uc.execute();

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(15);
    // No es un envelope: no tiene `data`, `total`, `stats`
    expect((result as any).data).toBeUndefined();
    expect((result as any).total).toBeUndefined();
  });
});

// ── 2.2 execute({ page, limit }) → PaginatedRadiusSessionsDto ────────────────

describe('ListRadiusSessions — 2.2 envelope con page/limit', () => {
  it('execute({ page:1, limit:50 }) → envelope con shape completo', async () => {
    const repo = new InMemoryRadiusSessionRepository(); // 15 sesiones
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());

    const result = await uc.execute({ page: 1, limit: 50 }) as PaginatedRadiusSessionsDto;

    expect(result).toHaveProperty('data');
    expect(Array.isArray(result.data)).toBe(true);
    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('page', 1);
    expect(result).toHaveProperty('limit', 50);
    expect(result).toHaveProperty('hasNext');
    expect(result).toHaveProperty('stats');
    expect(result.stats).toHaveProperty('total');
    expect(result.stats).toHaveProperty('active');
    expect(result.stats).toHaveProperty('idle');
  });

  it('default limit=50 cuando no se pasa limit', async () => {
    const repo = new InMemoryRadiusSessionRepository();
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());

    const result = await uc.execute({ page: 1 }) as PaginatedRadiusSessionsDto;

    expect(result.limit).toBe(50);
  });

  it('default page=1 cuando no se pasa page', async () => {
    const repo = new InMemoryRadiusSessionRepository();
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());

    const result = await uc.execute({ limit: 10 }) as PaginatedRadiusSessionsDto;

    expect(result.page).toBe(1);
  });

  it('cap de limit en 200: limit=999 → efectivamente 200', async () => {
    // Creamos 250 sesiones para que el cap sea observable
    const sessions = Array.from({ length: 250 }, (_, i) =>
      makeSession({ id: `s${i}`, username: `u${i}@x.com` })
    );
    const uc = new ListRadiusSessions(new StubRepo(sessions), new InMemoryPppoeServiceRepository());

    const result = await uc.execute({ page: 1, limit: 999 }) as PaginatedRadiusSessionsDto;

    expect(result.limit).toBe(200);
    expect(result.data.length).toBeLessThanOrEqual(200);
  });

  it('hasNext=true cuando hay más páginas', async () => {
    const repo = new InMemoryRadiusSessionRepository(); // 15 sesiones
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());

    const result = await uc.execute({ page: 1, limit: 10 }) as PaginatedRadiusSessionsDto;

    expect(result.total).toBe(15);
    expect(result.data).toHaveLength(10);
    expect(result.hasNext).toBe(true);
  });

  it('hasNext=false en la última página', async () => {
    const repo = new InMemoryRadiusSessionRepository(); // 15 sesiones
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());

    const result = await uc.execute({ page: 2, limit: 10 }) as PaginatedRadiusSessionsDto;

    expect(result.total).toBe(15);
    expect(result.data).toHaveLength(5);
    expect(result.hasNext).toBe(false);
  });

  it('página fuera de rango → data vacía, total correcto', async () => {
    const repo = new InMemoryRadiusSessionRepository(); // 15 sesiones
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());

    const result = await uc.execute({ page: 100, limit: 50 }) as PaginatedRadiusSessionsDto;

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(15);
    expect(result.hasNext).toBe(false);
  });

  it('data contiene RadiusSessionDto (no entidades crudas con metadata interna)', async () => {
    const repo = new InMemoryRadiusSessionRepository();
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());

    const result = await uc.execute({ page: 1, limit: 5 }) as PaginatedRadiusSessionsDto;

    expect(result.data[0]).toHaveProperty('id');
    expect(result.data[0]).toHaveProperty('username');
    expect(result.data[0]).toHaveProperty('status');
    expect(result.data[0]).toHaveProperty('contractId');
  });
});

// ── 2.3 Filtro search ─────────────────────────────────────────────────────────

describe('ListRadiusSessions — 2.3 filtro search', () => {
  /**
   * NOTA: el use case re-enriquece desde pppoeRepo, por lo que customerName en makeSession
   * queda sobreescrito. Para testear match por customerName, sembramos el pppoeRepo.
   */
  const sessions = [
    makeSession({ id: 's1', username: 'juan.perez@ipnext.com.ar', ipAddress: '10.75.0.100', macAddress: 'AA:BB:CC:11:22:33' }),
    makeSession({ id: 's2', username: 'maria.gomez@ipnext.com.ar', ipAddress: '10.75.0.200', macAddress: 'AA:BB:CC:44:55:66' }),
    makeSession({ id: 's3', username: 'carlos@ipnext.com.ar', ipAddress: '10.80.0.1', macAddress: 'DD:EE:FF:01:02:03' }),
  ];

  async function buildPppoeRepo() {
    const repo = new InMemoryPppoeServiceRepository();
    // Asociamos juan.perez → contrato con cliente 'Juan Pérez'
    await repo.upsertByUsername({ username: 'juan.perez@ipnext.com.ar', password: 'p', nasId: 'nas-1', contractId: 'c1' });
    repo.setContractClient('c1', 'cli1', 'Juan Pérez');
    // Asociamos maria.gomez → contrato con cliente 'María Gómez'
    await repo.upsertByUsername({ username: 'maria.gomez@ipnext.com.ar', password: 'p', nasId: 'nas-1', contractId: 'c2' });
    repo.setContractClient('c2', 'cli2', 'María Gómez');
    // carlos no tiene pppoe → customerName queda null
    return repo;
  }

  it('match por username (case-insensitive, substring)', async () => {
    const pppoeRepo = await buildPppoeRepo();
    const uc = new ListRadiusSessions(new StubRepo(sessions), pppoeRepo);
    const result = await uc.execute({ search: 'PEREZ' }) as PaginatedRadiusSessionsDto;

    expect(result.data.map(s => s.id)).toContain('s1');
    expect(result.data.map(s => s.id)).not.toContain('s2');
  });

  it('match por customerName (case-insensitive, substring)', async () => {
    const pppoeRepo = await buildPppoeRepo();
    const uc = new ListRadiusSessions(new StubRepo(sessions), pppoeRepo);
    const result = await uc.execute({ search: 'gómez' }) as PaginatedRadiusSessionsDto;

    expect(result.data.map(s => s.id)).toContain('s2');
  });

  it('match por ipAddress (substring)', async () => {
    const pppoeRepo = await buildPppoeRepo();
    const uc = new ListRadiusSessions(new StubRepo(sessions), pppoeRepo);
    const result = await uc.execute({ search: '10.75' }) as PaginatedRadiusSessionsDto;

    expect(result.data.map(s => s.id)).toContain('s1');
    expect(result.data.map(s => s.id)).toContain('s2');
    expect(result.data.map(s => s.id)).not.toContain('s3');
  });

  it('match por macAddress (substring, case-insensitive)', async () => {
    const pppoeRepo = await buildPppoeRepo();
    const uc = new ListRadiusSessions(new StubRepo(sessions), pppoeRepo);
    const result = await uc.execute({ search: 'dd:ee:ff' }) as PaginatedRadiusSessionsDto;

    expect(result.data.map(s => s.id)).toContain('s3');
    expect(result.data.map(s => s.id)).not.toContain('s1');
  });

  it('sesión sin contrato (customerName=null) no rompe el search', async () => {
    // carlos no tiene pppoe → customerName null → búsqueda no debe fallar
    const pppoeRepo = await buildPppoeRepo();
    const uc = new ListRadiusSessions(new StubRepo(sessions), pppoeRepo);
    const result = await uc.execute({ search: 'zzz' }) as PaginatedRadiusSessionsDto;

    expect(result).toBeDefined();
    expect(result.data).toHaveLength(0);
  });

  it('sin resultados → data vacía, total=0', async () => {
    const pppoeRepo = await buildPppoeRepo();
    const uc = new ListRadiusSessions(new StubRepo(sessions), pppoeRepo);
    const result = await uc.execute({ search: 'zzzzznomatch' }) as PaginatedRadiusSessionsDto;

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

// ── 2.4 Filtro nasId ──────────────────────────────────────────────────────────

describe('ListRadiusSessions — 2.4 filtro nasId', () => {
  const sessions = [
    makeSession({ id: 's1', username: 'u1@x.com', nasId: 'nas-1' }),
    makeSession({ id: 's2', username: 'u2@x.com', nasId: 'nas-1' }),
    makeSession({ id: 's3', username: 'u3@x.com', nasId: 'nas-2' }),
    makeSession({ id: 's4', username: 'u4@x.com', nasId: 'nas-3' }),
  ];

  it('filtra por nasId correcto', async () => {
    const uc = new ListRadiusSessions(new StubRepo(sessions), new InMemoryPppoeServiceRepository());
    const result = await uc.execute({ nasId: 'nas-1' }) as PaginatedRadiusSessionsDto;

    expect(result.total).toBe(2);
    expect(result.data.map(s => s.id)).toEqual(expect.arrayContaining(['s1', 's2']));
    expect(result.data.map(s => s.id)).not.toContain('s3');
    expect(result.data.map(s => s.id)).not.toContain('s4');
  });

  it('nasId que no existe → data vacía', async () => {
    const uc = new ListRadiusSessions(new StubRepo(sessions), new InMemoryPppoeServiceRepository());
    const result = await uc.execute({ nasId: 'nas-99' }) as PaginatedRadiusSessionsDto;

    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});

// ── 2.5 Filtro status ─────────────────────────────────────────────────────────

describe('ListRadiusSessions — 2.5 filtro status', () => {
  // El in-memory tiene 15 sesiones: i>12 → idle (sesiones 13,14,15 = 3 idle; 1-12 = 12 active)
  const repo = new InMemoryRadiusSessionRepository();

  it('status=active → solo sesiones active', async () => {
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());
    const result = await uc.execute({ status: 'active' }) as PaginatedRadiusSessionsDto;

    expect(result.data.every(s => s.status === 'active')).toBe(true);
    expect(result.total).toBe(12);
  });

  it('status=idle → solo sesiones idle (el in-memory las produce)', async () => {
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());
    const result = await uc.execute({ status: 'idle' }) as PaginatedRadiusSessionsDto;

    expect(result.data.every(s => s.status === 'idle')).toBe(true);
    expect(result.total).toBe(3);
  });
});

// ── 2.6 stats — ignora el filtro status ──────────────────────────────────────

describe('ListRadiusSessions — 2.6 stats ignoran status', () => {
  const sessions = [
    makeSession({ id: 's1', username: 'u1@x.com', nasId: 'nas-1', status: 'active' }),
    makeSession({ id: 's2', username: 'u2@x.com', nasId: 'nas-1', status: 'active' }),
    makeSession({ id: 's3', username: 'u3@x.com', nasId: 'nas-1', status: 'idle' }),
    makeSession({ id: 's4', username: 'u4@x.com', nasId: 'nas-2', status: 'active' }),
  ];

  it('stats refleja el set search+nasId sin importar el filtro status', async () => {
    const uc = new ListRadiusSessions(new StubRepo(sessions), new InMemoryPppoeServiceRepository());

    // Filtramos por nasId=nas-1 (3 sesiones: 2 active + 1 idle) y status=active
    const result = await uc.execute({ nasId: 'nas-1', status: 'active' }) as PaginatedRadiusSessionsDto;

    // data/total: solo las active de nas-1
    expect(result.total).toBe(2);
    expect(result.data.every(s => s.status === 'active')).toBe(true);

    // stats: sobre el set nasId=nas-1 IGNORANDO status → 3 sesiones (2 active + 1 idle)
    expect(result.stats.total).toBe(3);
    expect(result.stats.active).toBe(2);
    expect(result.stats.idle).toBe(1);
  });

  it('active + idle === stats.total (siempre)', async () => {
    const repo = new InMemoryRadiusSessionRepository(); // mix de active e idle
    const uc = new ListRadiusSessions(repo, new InMemoryPppoeServiceRepository());

    const result = await uc.execute({ page: 1, limit: 50 }) as PaginatedRadiusSessionsDto;

    expect(result.stats.active + result.stats.idle).toBe(result.stats.total);
  });

  it('stats.total es el número del badge (sin filtro status = todos los que matchean search+nasId)', async () => {
    const uc = new ListRadiusSessions(new StubRepo(sessions), new InMemoryPppoeServiceRepository());

    const result = await uc.execute({ page: 1, limit: 50 }) as PaginatedRadiusSessionsDto;

    // Sin nasId ni search → stats.total = todas las sesiones
    expect(result.stats.total).toBe(4);
    expect(result.stats.active).toBe(3);
    expect(result.stats.idle).toBe(1);
  });
});

// ── 2.7 Combinación search + nasId + status + page + limit ────────────────────

describe('ListRadiusSessions — 2.7 combinación de filtros + paginación', () => {
  // 10 sesiones en nas-1 con username que contiene "client", 5 active + 5 idle
  const sessions = Array.from({ length: 10 }, (_, i) =>
    makeSession({
      id: `s${i + 1}`,
      username: `client${i + 1}@ipnext.com.ar`,
      nasId: 'nas-1',
      status: i < 5 ? 'active' : 'idle',
    })
  ).concat([
    // 2 sesiones en nas-2 que también tienen "client" en username
    makeSession({ id: 's11', username: 'client11@ipnext.com.ar', nasId: 'nas-2', status: 'active' }),
    // 1 sesión en nas-1 sin "client" en el username
    makeSession({ id: 's12', username: 'other@ipnext.com.ar', nasId: 'nas-1', status: 'active' }),
  ]);

  it('search + nasId + status + page/limit: total correcto, página correcta', async () => {
    const uc = new ListRadiusSessions(new StubRepo(sessions), new InMemoryPppoeServiceRepository());

    // search=client, nasId=nas-1, status=active, page=1, limit=3
    // → 5 sesiones que matchean (client + nas-1 + active)
    const result = await uc.execute({
      search: 'client',
      nasId: 'nas-1',
      status: 'active',
      page: 1,
      limit: 3,
    }) as PaginatedRadiusSessionsDto;

    expect(result.total).toBe(5);
    expect(result.data).toHaveLength(3);
    expect(result.hasNext).toBe(true);
    // stats: sobre search=client + nasId=nas-1 (10 sesiones, ignorando status)
    expect(result.stats.total).toBe(10);
    expect(result.stats.active).toBe(5);
    expect(result.stats.idle).toBe(5);
  });

  it('orden estable username ASC cross-página sin duplicados ni huecos', async () => {
    const uc = new ListRadiusSessions(new StubRepo(sessions), new InMemoryPppoeServiceRepository());

    const page1 = await uc.execute({ nasId: 'nas-1', page: 1, limit: 4 }) as PaginatedRadiusSessionsDto;
    const page2 = await uc.execute({ nasId: 'nas-1', page: 2, limit: 4 }) as PaginatedRadiusSessionsDto;
    const page3 = await uc.execute({ nasId: 'nas-1', page: 3, limit: 4 }) as PaginatedRadiusSessionsDto;

    const all = [...page1.data, ...page2.data, ...page3.data];

    // Total esperado: 11 sesiones en nas-1 (10 client + 1 other)
    expect(page1.total).toBe(11);
    expect(all).toHaveLength(11); // sin duplicados ni huecos

    // Deben estar ordenados por username ASC (sin duplicados)
    const usernames = all.map(s => s.username);
    const sorted = [...usernames].sort();
    expect(usernames).toEqual(sorted);
  });

  it('hasNext = page*limit < total (fórmula correcta)', async () => {
    const uc = new ListRadiusSessions(new StubRepo(sessions), new InMemoryPppoeServiceRepository());

    // 12 sesiones en total (sin filtros), limit=5
    const p1 = await uc.execute({ page: 1, limit: 5 }) as PaginatedRadiusSessionsDto;
    const p2 = await uc.execute({ page: 2, limit: 5 }) as PaginatedRadiusSessionsDto;
    const p3 = await uc.execute({ page: 3, limit: 5 }) as PaginatedRadiusSessionsDto; // 2 elementos

    expect(p1.hasNext).toBe(true);  // 1*5=5 < 12
    expect(p2.hasNext).toBe(true);  // 2*5=10 < 12
    expect(p3.hasNext).toBe(false); // 3*5=15 >= 12
  });
});

// ── 2.8 F1: orden total con tiebreaker por id ─────────────────────────────────
//
// Escenario real: usernames DUPLICADOS (session_stuck + reconexión) y el orchestrator
// devuelve el snapshot en ORDEN DISTINTO entre requests sucesivos (no hay garantía de
// orden estable upstream). Si el sort solo compara username, el desempate entre
// duplicados queda a merced del orden de entrada (Array.sort es estable) → páginas
// sucesivas pueden duplicar o perder filas. El fix agrega tiebreaker por `id` (único).

/** Repo que devuelve el MISMO set de sesiones pero en orden DISTINTO en cada llamada. */
class ReorderingStubRepo implements RadiusSessionRepository {
  private callCount = 0;
  constructor(private readonly sessions: RadiusSession[]) {}

  async listSessions(): Promise<RadiusSession[]> {
    const copy = [...this.sessions];
    const call = this.callCount++;
    // Alterna entre reverse() y una rotación — garantiza orden de entrada distinto
    // en llamadas sucesivas (simula el orchestrator sin orden estable garantizado).
    if (call % 2 === 0) {
      return copy.reverse();
    }
    const mid = Math.floor(copy.length / 2);
    return [...copy.slice(mid), ...copy.slice(0, mid)];
  }

  async disconnectSession(): Promise<{ success: boolean }> { return { success: true }; }
}

describe('ListRadiusSessions — 2.8 F1 orden total con tiebreaker id (paginación cross-request)', () => {
  // 4 sesiones con el MISMO username (duplicado real) + 2 con username único.
  const sessions = [
    makeSession({ id: 's1', username: 'dup@x.com' }),
    makeSession({ id: 's2', username: 'dup@x.com' }),
    makeSession({ id: 's3', username: 'dup@x.com' }),
    makeSession({ id: 's4', username: 'aaa@x.com' }),
    makeSession({ id: 's5', username: 'zzz@x.com' }),
    makeSession({ id: 's6', username: 'dup@x.com' }),
  ];

  it('páginas consistentes, recorrido completo sin duplicados ni huecos aunque el repo reordene entre llamadas', async () => {
    const uc = new ListRadiusSessions(new ReorderingStubRepo(sessions), new InMemoryPppoeServiceRepository());

    // 3 requests independientes (cada uno dispara una llamada a repo.listSessions() con
    // orden de entrada DISTINTO) — exactamente el escenario cross-request real.
    const p1 = await uc.execute({ page: 1, limit: 2 }) as PaginatedRadiusSessionsDto;
    const p2 = await uc.execute({ page: 2, limit: 2 }) as PaginatedRadiusSessionsDto;
    const p3 = await uc.execute({ page: 3, limit: 2 }) as PaginatedRadiusSessionsDto;

    const allIds = [...p1.data, ...p2.data, ...p3.data].map(s => s.id);

    // Sin duplicados ni huecos: las 6 sesiones aparecen exactamente una vez.
    expect(allIds).toHaveLength(6);
    expect(new Set(allIds).size).toBe(6);
    expect([...allIds].sort()).toEqual(['s1', 's2', 's3', 's4', 's5', 's6']);

    // Orden determinístico: username ASC, tiebreaker id ASC entre duplicados.
    // aaa@x.com (s4) < dup@x.com (s1,s2,s3,s6 por id ASC) < zzz@x.com (s5)
    expect(allIds).toEqual(['s4', 's1', 's2', 's3', 's6', 's5']);
  });

  it('el mismo request repetido produce SIEMPRE el mismo orden pese al reordenamiento del repo', async () => {
    const uc1 = new ListRadiusSessions(new ReorderingStubRepo(sessions), new InMemoryPppoeServiceRepository());
    const uc2 = new ListRadiusSessions(new ReorderingStubRepo(sessions), new InMemoryPppoeServiceRepository());

    const r1 = await uc1.execute({ page: 1, limit: 6 }) as PaginatedRadiusSessionsDto;
    const r2 = await uc2.execute({ page: 1, limit: 6 }) as PaginatedRadiusSessionsDto;

    expect(r1.data.map(s => s.id)).toEqual(r2.data.map(s => s.id));
  });
});
