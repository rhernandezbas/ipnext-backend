import { IngestTeamLocations } from '@application/use-cases/IngestTeamLocations';
import { InMemoryTeamLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryTeamLocationRepository';
import type { TeamLocationPoint } from '@domain/entities/team-location-point';
import type { TeamDescriptor, TeamLocationSource, TeamTrailPage } from '@domain/ports/TeamLocationSource';

const NOW = new Date('2026-07-26T12:00:00Z');

const team = (login: string, externalId: string, status = 'Ativo'): TeamDescriptor => ({
  login,
  name: login,
  externalId,
  status,
});

const point = (iso: string, teamLogin: string, lat = -34.65): TeamLocationPoint => ({
  teamLogin,
  latitude: lat,
  longitude: -59.44,
  recordedAt: new Date(iso),
  accuracyMeters: 7.5,
  sources: [1],
});

/** Fuente scripteada: rastro por externalId. */
function makeSource(config: {
  teams: TeamDescriptor[];
  trails: Record<string, TeamTrailPage>;
}): TeamLocationSource & { watermarksSeen: Record<string, Date | null | undefined> } {
  const watermarksSeen: Record<string, Date | null | undefined> = {};
  return {
    watermarksSeen,
    async listTeams() {
      return config.teams;
    },
    async listTeamLocations(externalId, _teamLogin, stopAtOrBefore) {
      watermarksSeen[externalId] = stopAtOrBefore;
      return config.trails[externalId] ?? { points: [], pagesRead: 1, incomplete: false, pointsDropped: 0 };
    },
    async getLastTeamLocation() {
      return null;
    },
  };
}

describe('IngestTeamLocations', () => {
  it('persists the trail of every team and reports the counters', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const source = makeSource({
      teams: [team('IPNXANDYM', '1'), team('IPNXDENIC', '2')],
      trails: {
        '1': {
          points: [point('2026-07-26T11:00:00Z', 'IPNXANDYM'), point('2026-07-26T11:10:00Z', 'IPNXANDYM', -34.66)],
          pagesRead: 3,
          incomplete: false,
          pointsDropped: 0,
        },
        '2': { points: [point('2026-07-26T11:05:00Z', 'IPNXDENIC')], pagesRead: 2, incomplete: false, pointsDropped: 0 },
      },
    });

    const summary = await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();

    expect(summary.teamsProcessed).toBe(2);
    expect(summary.pointsNew).toBe(3);
    expect(summary.pointsDuplicate).toBe(0);
    expect(summary.pagesRead).toBe(5);
    expect(summary.incompleteTeams).toEqual([]);
  });

  it('passes the CONTIGUOUS watermark, which only advances after a COMPLETE read', async () => {
    // Hallazgo 2.2: el watermark ya NO se deriva de MAX(recordedAt) de lo persistido.
    // Se deriva del estado de ingest, que sólo avanza cuando la lectura no tuvo huecos.
    const repo = new InMemoryTeamLocationRepository();
    const source = makeSource({
      teams: [team('IPNXANDYM', '1')],
      trails: {
        '1': { points: [point('2026-07-26T10:00:00Z', 'IPNXANDYM')], pagesRead: 1, incomplete: false, pointsDropped: 0 },
      },
    });

    await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();
    expect(source.watermarksSeen['1']).toBeNull(); // primera corrida

    await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();
    // Segunda corrida: la primera fue COMPLETA, así que el watermark avanzó.
    expect(source.watermarksSeen['1']?.toISOString()).toBe('2026-07-26T10:00:00.000Z');
  });

  it('RATCHET ROTO: una lectura INCOMPLETA no avanza el watermark', async () => {
    // El bug original: el rastro viene DESCENDENTE, así que una lectura parcial trae los
    // puntos MÁS NUEVOS. Al persistirlos, MAX(recordedAt) saltaba POR ENCIMA del hueco y
    // la corrida siguiente cortaba en la página 1 reportando "limpio". La cola nunca se
    // volvía a pedir e IClass la purgaba a los 30 días.
    const repo = new InMemoryTeamLocationRepository();
    const source = makeSource({
      teams: [team('IPNXANDYM', '1')],
      trails: {
        '1': {
          points: [point('2026-07-26T11:00:00Z', 'IPNXANDYM')], // el MÁS NUEVO
          pagesRead: 4,
          incomplete: true, // 429 persistente a mitad del rastro
          pointsDropped: 0,
        },
      },
    });

    const first = await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();
    expect(first.incompleteTeams).toEqual(['IPNXANDYM']);
    expect(first.pointsNew).toBe(1); // lo leído SÍ se persiste

    await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();

    // LA CLAVE: sigue pidiendo desde el principio, no desde el punto más nuevo persistido.
    expect(source.watermarksSeen['1']).toBeNull();

    const state = await repo.getIngestState('IPNXANDYM');
    expect(state!.contiguousWatermark).toBeNull();
    expect(state!.consecutiveIncomplete).toBe(2);
  });

  it('cuenta los puntos ilegibles en el resumen de la corrida', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const source = makeSource({
      teams: [team('IPNXANDYM', '1')],
      trails: {
        '1': { points: [], pagesRead: 22, incomplete: true, pointsDropped: 2200 },
      },
    });

    const summary = await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();
    // Sin este contador, un cambio de formato en IClass se ve como corrida exitosa vacía.
    expect(summary.pointsDropped).toBe(2200);
    expect(summary.pointsNew).toBe(0);
  });

  it('passes a null watermark on the first ingest of a team', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const source = makeSource({ teams: [team('IPNXNUEVO', '9')], trails: {} });

    await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();
    expect(source.watermarksSeen['9']).toBeNull();
  });

  it('flags an INCOMPLETE team and does not count it as successful', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const source = makeSource({
      teams: [team('IPNXANDYM', '1'), team('IPNXEMAV', '2')],
      trails: {
        '1': { points: [point('2026-07-26T11:00:00Z', 'IPNXANDYM')], pagesRead: 1, incomplete: false, pointsDropped: 0 },
        // rate-limit persistente: trajo algo, pero no todo
        '2': { points: [point('2026-07-26T11:00:00Z', 'IPNXEMAV')], pagesRead: 4, incomplete: true, pointsDropped: 0 },
      },
    });

    const summary = await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();

    expect(summary.incompleteTeams).toEqual(['IPNXEMAV']);
    // Lo que SÍ se leyó se persiste igual — descartarlo perdería dato que expira en 30 días.
    expect(summary.pointsNew).toBe(2);
  });

  it('is idempotent — a second run over the same trail inserts nothing new', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const trail = {
      '1': { points: [point('2026-07-26T11:00:00Z', 'IPNXANDYM')], pagesRead: 1, incomplete: false, pointsDropped: 0 },
    };
    const source = makeSource({ teams: [team('IPNXANDYM', '1')], trails: trail });

    const first = await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();
    const second = await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();

    expect(first.pointsNew).toBe(1);
    expect(second.pointsNew).toBe(0);
    expect(second.pointsDuplicate).toBe(1);
  });

  it('purges points older than the 12-month retention and reports the count', async () => {
    const repo = new InMemoryTeamLocationRepository();
    await repo.saveMany([
      point('2025-06-01T12:00:00Z', 'IPNXANDYM'),           // > 12 meses
      point('2026-07-01T12:00:00Z', 'IPNXANDYM', -34.66),   // dentro
    ]);
    const source = makeSource({ teams: [], trails: {} });

    const summary = await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();
    expect(summary.pointsPurged).toBe(1);
  });

  it('records the run summary for observability', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const source = makeSource({
      teams: [team('IPNXANDYM', '1')],
      trails: { '1': { points: [point('2026-07-26T11:00:00Z', 'IPNXANDYM')], pagesRead: 2, incomplete: false, pointsDropped: 0 } },
    });

    await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();

    expect(repo.runs).toHaveLength(1);
    expect(repo.runs[0].pointsNew).toBe(1);
    expect(repo.runs[0].pagesRead).toBe(2);
  });

  it('does not let one failing team abort the whole run', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const source: TeamLocationSource = {
      async listTeams() {
        return [team('IPNXBOOM', '1'), team('IPNXOK', '2')];
      },
      async listTeamLocations(externalId) {
        if (externalId === '1') throw new Error('boom');
        return { points: [point('2026-07-26T11:00:00Z', 'IPNXOK')], pagesRead: 1, incomplete: false, pointsDropped: 0 };
      },
      async getLastTeamLocation() {
        return null;
      },
    };

    const summary = await new IngestTeamLocations({ source, repo, now: () => NOW }).execute();

    // La cuadrilla que explotó queda marcada incompleta; la otra se ingesta igual.
    expect(summary.incompleteTeams).toEqual(['IPNXBOOM']);
    expect(summary.pointsNew).toBe(1);
  });
});
