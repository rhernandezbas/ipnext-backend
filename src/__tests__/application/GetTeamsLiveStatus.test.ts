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

  // The stored trail is refreshed every 6h by an ingest that is OFF in production, so the
  // live view asks IClass for the last position of each team (one cheap call per team).
  describe('live read from IClass', () => {
    function liveSource(teams: TeamDescriptor[], byLogin: Record<string, TeamLocationPoint | Error | null>) {
      const calls: string[] = [];
      return {
        calls,
        source: {
          ...source(teams),
          async getLastTeamLocation(login: string) {
            calls.push(login);
            const value = byLogin[login];
            if (value instanceof Error) throw value;
            return value ?? null;
          },
        } as TeamLocationSource,
      };
    }

    it('serves the position IClass reports now, over an older stored one', async () => {
      const repo = new InMemoryTeamLocationRepository();
      await repo.saveMany([point('2026-07-24T10:00:00Z', 'IPNXDENIC', -34.10, -59.10)]);
      const { source: live } = liveSource(
        [team('IPNXDENIC', 'Denis Corzo')],
        { IPNXDENIC: point('2026-07-26T12:44:00Z', 'IPNXDENIC', -34.65197742, -59.44804661) },
      );

      const res = await new GetTeamsLiveStatus({ repo, source: live, now: () => NOW }).execute();

      expect(res[0].state).toBe('ACTIVA');
      expect(res[0].latitude).toBe(-34.65197742);
      expect(res[0].minutesSinceLastPoint).toBeCloseTo(1, 1);
    });

    it('persists what it reads, so the history keeps growing without the ingest', async () => {
      const repo = new InMemoryTeamLocationRepository();
      const { source: live } = liveSource(
        [team('IPNXDENIC', 'Denis Corzo')],
        { IPNXDENIC: point('2026-07-26T12:44:00Z', 'IPNXDENIC') },
      );

      await new GetTeamsLiveStatus({ repo, source: live, now: () => NOW }).execute();

      expect(await repo.findLatestPerTeam()).toHaveLength(1);
    });

    it('falls back to the stored point when IClass fails for that team', async () => {
      const repo = new InMemoryTeamLocationRepository();
      await repo.saveMany([point('2026-07-26T12:41:45Z', 'IPNXDENIC')]);
      const { source: live } = liveSource(
        [team('IPNXDENIC', 'Denis Corzo')],
        { IPNXDENIC: new Error('IClass unavailable') },
      );

      const res = await new GetTeamsLiveStatus({ repo, source: live, now: () => NOW }).execute();

      expect(res[0].state).toBe('ACTIVA');
      expect(res[0].lastPointAt!.toISOString()).toBe('2026-07-26T12:41:45.000Z');
    });

    it('reuses the reading for a short while, so refreshing the map does not hammer IClass', async () => {
      const repo = new InMemoryTeamLocationRepository();
      const { calls, source: live } = liveSource(
        [team('IPNXDENIC', 'Denis Corzo')],
        { IPNXDENIC: point('2026-07-26T12:44:00Z', 'IPNXDENIC') },
      );
      let now = NOW;
      const useCase = new GetTeamsLiveStatus({ repo, source: live, now: () => now, liveCacheSeconds: 90 });

      await useCase.execute();
      await useCase.execute();
      expect(calls).toHaveLength(1);

      now = new Date(NOW.getTime() + 91_000);
      await useCase.execute();
      expect(calls).toHaveLength(2);
    });

    it('serves the stored point when it is NEWER than what IClass returns', async () => {
      const repo = new InMemoryTeamLocationRepository();
      await repo.saveMany([point('2026-07-26T12:44:00Z', 'IPNXDENIC', -34.65, -59.44)]);
      const { source: live } = liveSource(
        [team('IPNXDENIC', 'Denis Corzo')],
        { IPNXDENIC: point('2026-07-26T10:00:00Z', 'IPNXDENIC', -34.10, -59.10) },
      );

      const res = await new GetTeamsLiveStatus({ repo, source: live, now: () => NOW }).execute();

      expect(res[0].lastPointAt!.toISOString()).toBe('2026-07-26T12:44:00.000Z');
      expect(res[0].latitude).toBe(-34.65);
    });

    it('does not fan out once per concurrent reader of the map', async () => {
      const repo = new InMemoryTeamLocationRepository();
      const { calls, source: live } = liveSource(
        [team('IPNXDENIC', 'Denis Corzo')],
        { IPNXDENIC: point('2026-07-26T12:44:00Z', 'IPNXDENIC') },
      );
      const useCase = new GetTeamsLiveStatus({ repo, source: live, now: () => NOW });

      await Promise.all([useCase.execute(), useCase.execute(), useCase.execute()]);

      expect(calls).toEqual(['IPNXDENIC']);
    });

    // Ante un "Espere um pouco" de IClass todas fallan: reintentar en cada refresco del
    // mapa hostiga a la API que acaba de pedir espera, pero esperar 90s es demasiado.
    it('backs off briefly when IClass failed for every team, then retries', async () => {
      const repo = new InMemoryTeamLocationRepository();
      await repo.saveMany([point('2026-07-26T12:41:45Z', 'IPNXDENIC')]);
      const { calls, source: live } = liveSource(
        [team('IPNXDENIC', 'Denis Corzo')],
        { IPNXDENIC: new Error('IClass unavailable') },
      );
      let now = NOW;
      const useCase = new GetTeamsLiveStatus({ repo, source: live, now: () => now, liveRetrySeconds: 15 });

      await useCase.execute();
      const res = await useCase.execute();
      expect(calls).toHaveLength(1);
      expect(res[0].state).toBe('ACTIVA'); // sigue sirviendo lo persistido

      now = new Date(NOW.getTime() + 16_000);
      await useCase.execute();
      expect(calls).toHaveLength(2);
    });

    it('retries on the next request the teams IClass failed for, without waiting the full window', async () => {
      const repo = new InMemoryTeamLocationRepository();
      const responses: Record<string, TeamLocationPoint | Error | null> = {
        IPNXDENIC: point('2026-07-26T12:44:00Z', 'IPNXDENIC'),
        IPNXANDYM: new Error('IClass unavailable'),
      };
      const { calls, source: live } = liveSource(
        [team('IPNXDENIC', 'Denis'), team('IPNXANDYM', 'Andy')],
        responses,
      );
      const useCase = new GetTeamsLiveStatus({ repo, source: live, now: () => NOW });

      await useCase.execute();
      responses.IPNXANDYM = point('2026-07-26T12:44:30Z', 'IPNXANDYM');
      const res = await useCase.execute();

      expect(calls.filter(c => c === 'IPNXANDYM')).toHaveLength(2);
      // …y sólo a esa: releer el roster entero amplificaría la carga sobre un IClass ya lento.
      expect(calls.filter(c => c === 'IPNXDENIC')).toHaveLength(1);
      expect(res.find(r => r.login === 'IPNXANDYM')!.state).toBe('ACTIVA');
      expect(res.find(r => r.login === 'IPNXDENIC')!.state).toBe('ACTIVA');
    });

    it('gives up on IClass when the reading budget is spent, serving what is stored', async () => {
      const repo = new InMemoryTeamLocationRepository();
      await repo.saveMany([point('2026-07-26T12:41:45Z', 'IPNXDENIC')]);
      const { calls, source: live } = liveSource(
        [team('IPNXDENIC', 'Denis Corzo')],
        { IPNXDENIC: point('2026-07-26T12:44:00Z', 'IPNXDENIC') },
      );

      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const res = await new GetTeamsLiveStatus({ repo, source: live, now: () => NOW, liveBudgetSeconds: 0 }).execute();

      expect(calls).toHaveLength(0);
      expect(res[0].lastPointAt!.toISOString()).toBe('2026-07-26T12:41:45.000Z');
      // Apagado por configuración: no corresponde acusar a IClass de no responder.
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    // Al vencer el presupuesto la respuesta ya se fue: lo que llegue tarde no puede
    // colarse en el cache ni marcar a esa cuadrilla como leída.
    it('ignores a reply that arrives after the reading budget expired', async () => {
      const repo = new InMemoryTeamLocationRepository();
      let releaseLate: (() => void) | undefined;
      const late = new Promise<void>((resolve) => {
        releaseLate = resolve;
      });
      const calls: string[] = [];
      const live: TeamLocationSource = {
        ...source([team('IPNXDENIC', 'Denis'), team('IPNXANDYM', 'Andy')]),
        async getLastTeamLocation(login: string) {
          calls.push(login);
          if (login === 'IPNXANDYM') await late;
          return point('2026-07-26T12:44:00Z', login);
        },
      };
      const useCase = new GetTeamsLiveStatus({
        repo, source: live, now: () => NOW, liveBudgetSeconds: 0.05, liveConcurrency: 2,
      });

      const res = await useCase.execute();
      expect(res.find(r => r.login === 'IPNXANDYM')!.state).toBe('SIN_RASTRO'); // no esperó
      releaseLate!();
      await late;
      await new Promise((r) => setImmediate(r));

      // El punto tardío no se coló en el rastro a espaldas del guardado…
      expect((await repo.findLatestPerTeam()).map(p => p.teamLogin)).toEqual(['IPNXDENIC']);

      await useCase.execute();

      // …ni dejó la cuadrilla marcada como leída.
      expect(calls.filter(c => c === 'IPNXANDYM')).toHaveLength(2);
    });

    // Releer una cuadrilla no puede extenderle la ventana a las demás: si no, una que
    // falla seguido mantiene al resto del mapa congelado ventana tras ventana.
    it('does not renew the cache window for the teams it did not re-read', async () => {
      const repo = new InMemoryTeamLocationRepository();
      const responses: Record<string, TeamLocationPoint | Error | null> = {
        IPNXDENIC: point('2026-07-26T12:44:00Z', 'IPNXDENIC'),
        IPNXANDYM: new Error('IClass unavailable'),
      };
      const { calls, source: live } = liveSource(
        [team('IPNXDENIC', 'Denis'), team('IPNXANDYM', 'Andy')],
        responses,
      );
      let now = NOW;
      const useCase = new GetTeamsLiveStatus({ repo, source: live, now: () => now, liveCacheSeconds: 90 });

      await useCase.execute();
      now = new Date(NOW.getTime() + 50_000);
      responses.IPNXANDYM = point('2026-07-26T12:45:00Z', 'IPNXANDYM');
      await useCase.execute();
      expect(calls.filter(c => c === 'IPNXDENIC')).toHaveLength(1);

      now = new Date(NOW.getTime() + 95_000);
      await useCase.execute();

      expect(calls.filter(c => c === 'IPNXDENIC')).toHaveLength(2);
    });

    it('reads again for a team that joined the roster inside the cache window', async () => {
      const repo = new InMemoryTeamLocationRepository();
      const roster = [team('IPNXDENIC', 'Denis Corzo')];
      const { calls, source: live } = liveSource(roster, {
        IPNXDENIC: point('2026-07-26T12:44:00Z', 'IPNXDENIC'),
        IPNXNUEVO: point('2026-07-26T12:44:30Z', 'IPNXNUEVO'),
      });
      const useCase = new GetTeamsLiveStatus({ repo, source: live, now: () => NOW });

      await useCase.execute();
      roster.push(team('IPNXNUEVO', 'Nuevo'));
      const res = await useCase.execute();

      expect(calls).toContain('IPNXNUEVO');
      expect(res.find(r => r.login === 'IPNXNUEVO')!.state).toBe('ACTIVA');
    });

    it('persists the position exactly as IClass reported it', async () => {
      const repo = new InMemoryTeamLocationRepository();
      const { source: live } = liveSource(
        [team('IPNXDENIC', 'Denis Corzo')],
        { IPNXDENIC: point('2026-07-26T12:44:00Z', 'IPNXDENIC', -34.65197742, -59.44804661) },
      );

      await new GetTeamsLiveStatus({ repo, source: live, now: () => NOW }).execute();

      const [stored] = await repo.findLatestPerTeam();
      expect(stored.latitude).toBe(-34.65197742);
      expect(stored.longitude).toBe(-59.44804661);
      expect(stored.recordedAt.toISOString()).toBe('2026-07-26T12:44:00.000Z');
    });

    it('keeps a team without any position as SIN_RASTRO', async () => {
      const repo = new InMemoryTeamLocationRepository();
      const { source: live } = liveSource([team('IPNXSEBAM', 'Seba M')], { IPNXSEBAM: null });

      const res = await new GetTeamsLiveStatus({ repo, source: live, now: () => NOW }).execute();

      expect(res[0].state).toBe('SIN_RASTRO');
    });
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
