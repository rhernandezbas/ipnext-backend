import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import { InMemoryRoleRepository } from '../../infrastructure/adapters/in-memory/InMemoryRoleRepository';
import { ListRoles } from '../../application/use-cases/ListRoles';
import { GetRole } from '../../application/use-cases/GetRole';
import { CreateRole } from '../../application/use-cases/CreateRole';
import { UpdateRole } from '../../application/use-cases/UpdateRole';
import { DeleteRole } from '../../application/use-cases/DeleteRole';
import { createRoleRouter } from '../../infrastructure/http/routes/role.routes';

function buildApp() {
  const app = express();
  app.use(express.json());

  const repo = new InMemoryRoleRepository();
  const listRoles = new ListRoles(repo);
  const getRole = new GetRole(repo);
  const createRole = new CreateRole(repo);
  const updateRole = new UpdateRole(repo);
  const deleteRole = new DeleteRole(repo);

  app.use('/api/roles', createRoleRouter(listRoles, getRole, createRole, updateRole, deleteRole));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

describe('GET /api/roles', () => {
  it('returns 200 with array of roles', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/roles');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(6);
  });
});

describe('POST /api/roles', () => {
  it('returns 201 with new role', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/roles')
      .send({
        name: 'billing_only',
        description: 'Can only read billing',
        isSystem: false,
        permissions: [{ module: 'billing', actions: ['read'] }],
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    expect(res.body.name).toBe('billing_only');
  });
});
