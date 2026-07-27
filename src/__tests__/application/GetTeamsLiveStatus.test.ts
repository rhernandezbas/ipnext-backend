import { GetTeamsLiveStatus } from '@application/use-cases/GetTeamsLiveStatus';
import { GetTeamDailyJourney } from '@application/use-cases/GetTeamDailyJourney';
import { InMemoryTeamLocationRepository } from '@infrastructure/adapters/in-memory/InMemoryTeamLocationRepository';
import type { TeamDescriptor, TeamLocationSource } from '@domain/ports/TeamLocationSource';
import type { TeamLocationPoint } from '@domain/entities/team-location-point';

const NOW = new Date('2026-07-26T12:45:00Z'); // 09:45 AR

const team = (login: string, name: string, status: string | null = 'Ativo'): TeamDescriptor => ({
  login,
  name,
  externalId: '1',
  status,
});

const point = (iso: string, teamLogin: string, lat = -34.65, lon = -59.44): TeamLocationPoint => ({
  teamLogin,
  latitude: lat,
  longitude: lon,
  recordedAt: new Date(iso),
  accuracyMeters: 7.5,
  sources: [1],
});

function source(teams: TeamDescriptor[]): TeamLocationSource {
  return {
    async listTeams() {
      return teams;
    },
    async listTeamLocations() {
      return { points: [], pagesRead: 0, incomplete: false, pointsDropped: 0 };
    },
    async getLastTeamLocation() {
      return null;
    },
  };
}

describe('GetTeamsLiveStatus', () => {
  it('classifies a team reporting minutes ago as ACTIVA', async () => {
    const repo = new InMemoryTeamLocationRepository();
    await repo.saveMany([point('2026-07-26T12:41:45Z', 'IPNXDENIC')]);

    const res = await new GetTeamsLiveStatus({
      repo,
      source: source([team('IPNXDENIC', 'Denis Corzo')]),
      now: () => NOW,
    }).execute();

    expect(res).toHaveLength(1);
    expect(res[0].state).toBe('ACTIVA');
    expect(res[0].name).toBe('Denis Corzo');
    expect(res[0].mapsUrl).toContain('google.com/maps');
    expect(res[0].minutesSinceLastPoint).toBeCloseTo(3.25, 1);
  });

  it('classifies a team whose last point is older than 24h as DESACTUALIZADA', async () => {
    const repo = new InMemoryTeamLocationRepository();
    await repo.saveMany([point('2026-07-24T23:54:31Z', 'IPNXANTONIOM')]);

    const res = await new GetTeamsLiveStatus({
      repo,
      source: source([team('IPNXANTONIOM', 'Antonio Marquez')]),
      now: () => NOW,
    }).execute();

    expect(res[0].state).toBe('DESACTUALIZADA');
    // La posición se devuelve, pero rotulada: NO debe dibujarse como actual.
    expect(res[0].latitude).not.toBeNull();
    expect(res[0].minutesSinceLastPoint).toBeGreaterThan(24 * 60);
  });

  it('classifies a team with no trail at all as SIN_RASTRO', async () => {
    const repo = new InMemoryTeamLocationRepository();

    const res = await new GetTeamsLiveStatus({
      repo,
      source: source([team('IPNXSEBAM', 'Seba M', 'Cancelado')]),
      now: () => NOW,
    }).execute();

    expect(res[0].state).toBe('SIN_RASTRO');
    expect(res[0].latitude).toBeNull();
    expect(res[0].mapsUrl).toBeNull();
  });

  it('does NOT infer tracking from the IClass team status', async () => {
    // Verificado: IPNXANDYM figura "Inativo" en IClass y sin embargo reporta hoy.
    const repo = new InMemoryTeamLocationRepository();
    await repo.saveMany([point('2026-07-26T12:38:31Z', 'IPNXANDYM')]);

    const res = await new GetTeamsLiveStatus({
      repo,
      source: source([team('IPNXANDYM', 'Andy Medina', 'Inativo')]),
      now: () => NOW,
    }).execute();

    expect(res[0].state).toBe('ACTIVA');
    expect(res[0].iclassStatus).toBe('Inativo');
  });

  it('lists every team in the roster, including those without points', async () => {
    const repo = new InMemoryTeamLocationRepository();
    await repo.saveMany([point('2026-07-26T12:38:31Z', 'IPNXANDYM')]);

    const res = await new GetTeamsLiveStatus({
      repo,
      source: source([team('IPNXANDYM', 'Andy'), team('IPNXSEBAM', 'Seba')]),
      now: () => NOW,
    }).execute();

    expect(res.map((r) => r.login).sort()).toEqual(['IPNXANDYM', 'IPNXSEBAM']);
  });
});

describe('GetTeamDailyJourney', () => {
  it('reports start, end, count and hourly distribution from the trail alone', async () => {
    const repo = new InMemoryTeamLocationRepository();
    await repo.saveMany([
      point('2026-07-26T09:08:00Z', 'IPNXANDYM'),  // 06:08 AR
      point('2026-07-26T10:15:00Z', 'IPNXANDYM', -34.66),  // 07:15 AR
      point('2026-07-26T10:45:00Z', 'IPNXANDYM', -34.67),  // 07:45 AR
      point('2026-07-26T12:38:00Z', 'IPNXANDYM', -34.68),  // 09:38 AR
    ]);

    const res = await new GetTeamDailyJourney({ repo }).execute({
      teamLogin: 'IPNXANDYM',
      argentinaDay: '2026-07-26',
    });

    expect(res.pointCount).toBe(4);
    expect(res.firstPointAt!.toISOString()).toBe('2026-07-26T09:08:00.000Z');
    expect(res.lastPointAt!.toISOString()).toBe('2026-07-26T12:38:00.000Z');
    // Horas en ARGENTINA, no en UTC.
    expect(res.pointsByHour['06']).toBe(1);
    expect(res.pointsByHour['07']).toBe(2);
    expect(res.pointsByHour['09']).toBe(1);
  });

  it('reports travelled distance as a LOWER BOUND with its sampling interval', async () => {
    const repo = new InMemoryTeamLocationRepository();
    await repo.saveMany([
      point('2026-07-26T09:00:00Z', 'IPNXANDYM', -34.65, -59.44),
      point('2026-07-26T09:10:00Z', 'IPNXANDYM', -34.66, -59.44),
    ]);

    const res = await new GetTeamDailyJourney({ repo }).execute({
      teamLogin: 'IPNXANDYM',
      argentinaDay: '2026-07-26',
    });

    // Sumar tramos rectos entre puntos espaciados "corta las curvas" y SUBESTIMA.
    expect(res.travelledMetersLowerBound).toBeGreaterThan(1000);
    expect(res.isLowerBound).toBe(true);
    expect(res.medianSamplingMinutes).toBeCloseTo(10, 1);
  });

  it('returns an empty journey without throwing when there are no points', async () => {
    const repo = new InMemoryTeamLocationRepository();
    const res = await new GetTeamDailyJourney({ repo }).execute({
      teamLogin: 'IPNXNADIE',
      argentinaDay: '2026-07-26',
    });

    expect(res.pointCount).toBe(0);
    expect(res.firstPointAt).toBeNull();
    expect(res.travelledMetersLowerBound).toBe(0);
  });

  it('does not report a sampling interval for a single point', async () => {
    const repo = new InMemoryTeamLocationRepository();
    await repo.saveMany([point('2026-07-26T09:00:00Z', 'IPNXANDYM')]);

    const res = await new GetTeamDailyJourney({ repo }).execute({
      teamLogin: 'IPNXANDYM',
      argentinaDay: '2026-07-26',
    });
    expect(res.medianSamplingMinutes).toBeNull();
    expect(res.travelledMetersLowerBound).toBe(0);
  });
});
