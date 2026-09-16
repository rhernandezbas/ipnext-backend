import request from 'supertest';
import express from 'express';
import { InMemoryIClassNodeRepository } from '../../../infrastructure/adapters/in-memory/InMemoryIClassNodeRepository';
import { InMemoryIClassTeamRepository } from '../../../infrastructure/adapters/in-memory/InMemoryIClassTeamRepository';
import { ListIClassNodeCatalog } from '../../../application/use-cases/ListIClassNodeCatalog';
import { ListIClassTeams } from '../../../application/use-cases/ListIClassTeams';
import { createInternalCatalogsRouter } from '../../../infrastructure/http/routes/internal-catalogs.routes';
import { errorHandler } from '../../../infrastructure/http/middleware/errorHandler';

function buildApp() {
  const app = express();
  app.use(express.json());

  const nodeRepo = new InMemoryIClassNodeRepository();
  const teamRepo = new InMemoryIClassTeamRepository();
  const listIClassNodeCatalog = new ListIClassNodeCatalog(nodeRepo);
  const listIClassTeams = new ListIClassTeams(teamRepo);

  // No auth middleware whatsoever — internal-only, same criterion as internal-tasks.routes.ts.
  app.use('/api/internal/catalogs', createInternalCatalogsRouter({
    listIClassNodeCatalog,
    listIClassTeams,
  }));

  app.use(errorHandler);

  return { app, nodeRepo, teamRepo };
}

describe('GET /api/internal/catalogs/cities — no auth required', () => {
  it('returns the IClass node catalog without any auth header/cookie', async () => {
    const { app, nodeRepo } = buildApp();
    await nodeRepo.upsertByNodeId({ nodeId: 1, code: 'Rosario', description: 'Rosario', selectable: true });
    await nodeRepo.upsertByNodeId({ nodeId: 2, code: 'Main', description: 'Main', selectable: false });

    const res = await request(app).get('/api/internal/catalogs/cities');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const codes = res.body.items.map((i: { code: string }) => i.code).sort();
    expect(codes).toEqual(['Main', 'Rosario']);
  });

  it('?active=true filters to only active nodes', async () => {
    const { app, nodeRepo } = buildApp();
    await nodeRepo.upsertByNodeId({ nodeId: 1, code: 'Rosario', description: 'Rosario', selectable: true });
    await nodeRepo.markInactiveExcept([]); // deactivates Rosario
    await nodeRepo.upsertByNodeId({ nodeId: 2, code: 'Chivilcoy', description: 'Chivilcoy', selectable: true });

    const res = await request(app).get('/api/internal/catalogs/cities').query({ active: 'true' });

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].code).toBe('Chivilcoy');
  });
});

describe('GET /api/internal/catalogs/teams — no auth required', () => {
  it('returns the IClass team catalog without any auth header/cookie', async () => {
    const { app, teamRepo } = buildApp();
    await teamRepo.upsertByLogin({ login: 'equipe-1', name: 'Equipe Uno', thirdPartyCode: null, active: true, selectable: true });
    await teamRepo.upsertByLogin({ login: 'equipe-2', name: 'Equipe Dos', thirdPartyCode: 'TP-2', active: false, selectable: true });

    const res = await request(app).get('/api/internal/catalogs/teams');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    const logins = res.body.items.map((i: { login: string }) => i.login).sort();
    expect(logins).toEqual(['equipe-1', 'equipe-2']);
    const first = res.body.items.find((i: { login: string }) => i.login === 'equipe-1');
    expect(first).toMatchObject({ login: 'equipe-1', name: 'Equipe Uno', active: true, selectable: true });
  });
});
