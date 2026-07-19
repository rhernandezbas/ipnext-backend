/**
 * N3 (network-task-broadcast) — POST /api/scheduling/:id/broadcast-noc (supertest, in-memory).
 * Button endpoint: difunde una tarea de RED al canal NOC vía el motor N1 (BroadcastToNoc).
 *  - network task → 200 { sent, link } y el gateway recibe "📧 [Red · {nodo}] {title}\n🔗 {link}"
 *  - customer task → 422 TASK_NOT_BROADCASTABLE
 *  - tarea inexistente → 404 TASK_NOT_FOUND
 *  - motor no configurado → 503 NOC_BROADCAST_NOT_CONFIGURED ; Evolution caído → 502 EVOLUTION_API_ERROR
 *  - gate scheduling:write denegado → 403 ; sin cookie → 401
 */
import request from 'supertest';
import express, { Request, Response, NextFunction, RequestHandler } from 'express';
import cookieParser from 'cookie-parser';
import { createSchedulingRouter } from '@infrastructure/http/routes/scheduling.routes';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { InMemorySchedulingRepository } from '@infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryStageRepository } from '@infrastructure/adapters/in-memory/InMemoryStageRepository';
import { InMemoryNocBroadcastConfigRepository } from '@infrastructure/adapters/in-memory/InMemoryNocBroadcastConfigRepository';
import { ListTasks } from '@application/use-cases/ListTasks';
import { GetTask } from '@application/use-cases/GetTask';
import { CreateTask } from '@application/use-cases/CreateTask';
import { UpdateTask } from '@application/use-cases/UpdateTask';
import { DeleteTask } from '@application/use-cases/DeleteTask';
import { MoveTaskToStage } from '@application/use-cases/MoveTaskToStage';
import { BroadcastToNoc } from '@application/use-cases/nocBroadcast/BroadcastToNoc';
import { BroadcastTaskToNoc } from '@application/use-cases/nocBroadcast/BroadcastTaskToNoc';
import { NocBroadcastGateway } from '@domain/ports/NocBroadcastGateway';
import { NocBroadcastNotConfiguredError, EvolutionApiError } from '@domain/errors/nocBroadcast';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { User } from '@domain/entities/auth';

const AUTH_COOKIE = 'auth_token=fake';
const BASE = 'http://190.7.234.37:7778';

class StubLookup implements EntityLookup {
  async findById(_id: string) { return null; }
}

class FakeAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' as const },
      cookieValue: 'fake',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'admin-1', username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

class FakeGateway implements NocBroadcastGateway {
  sent: string[] = [];
  error: Error | null = null;
  async sendText(text: string): Promise<void> {
    if (this.error) throw this.error;
    this.sent.push(text);
  }
}

const grant: RequestHandler = (_req, _res, next) => next();
const deny: RequestHandler = (_req: Request, res: Response, _next: NextFunction) => {
  res.status(403).json({ error: 'FORBIDDEN', code: 'PERMISSION_DENIED' });
};

async function buildApp(opts?: { write?: RequestHandler }) {
  const repo = new InMemorySchedulingRepository();
  const stageRepo = new InMemoryStageRepository();
  const configRepo = new InMemoryNocBroadcastConfigRepository();
  await configRepo.update({ appPublicUrl: BASE });
  const gateway = new FakeGateway();
  const engine = new BroadcastToNoc(configRepo, gateway);
  const broadcastTaskToNoc = new BroadcastTaskToNoc(repo, engine);
  const lookup = new StubLookup();

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use(
    '/api/scheduling',
    createSchedulingRouter(
      new ListTasks(repo),
      new GetTask(repo),
      new CreateTask(repo, lookup, lookup, lookup, lookup, lookup),
      new UpdateTask(repo, lookup, lookup, lookup, lookup, lookup),
      new DeleteTask(repo),
      new MoveTaskToStage(repo, stageRepo),
      new FakeAuthProvider(),
      undefined, // stageRepo
      undefined, // checklist
      undefined, // setTaskInventoryReview
      undefined, // bulkMoveTasksToStage
      undefined, // resendDeps
      undefined, // getTaskActivity
      undefined, // requireInventoryWrite
      undefined, // retireContractEquipment
      undefined, // setTaskGeneralStatus
      opts?.write ?? grant, // requireSchedulingWrite — reused as the broadcast gate
      undefined, // archiveTask
      undefined, // requireHardDelete
      undefined, // iclassActionDeps
      broadcastTaskToNoc,
    ),
  );
  app.use(errorHandler);
  return { app, repo, gateway };
}

describe('scheduling.routes — POST /:id/broadcast-noc (N3)', () => {
  it('network task → 200 { sent, link } and the gateway receives the composed NOC message', async () => {
    const { app, repo, gateway } = await buildApp();
    repo.seedTask({ id: 'net-1', kind: 'network', networkType: 'red', networkSiteName: 'Nodo Agote', title: 'Revisar OLT saturada' });

    const res = await request(app).post('/api/scheduling/net-1/broadcast-noc').set('Cookie', AUTH_COOKIE).send({});

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sent: true, link: `${BASE}/admin/scheduling/tasks/net-1` });
    expect(gateway.sent).toEqual([
      `📧 [Red · Nodo Agote] Revisar OLT saturada\n🔗 ${BASE}/admin/scheduling/tasks/net-1`,
    ]);
    // noc-broadcast-traceability — la ruta pasa el actor del req.user (FakeAuthProvider → 'test').
    const task = await repo.getTask('net-1');
    expect(task!.lastBroadcastByName).toBe('test');
    expect(task!.lastBroadcastAt).not.toBeNull();
  });

  it('network task without a node → message falls back to "[Red]"', async () => {
    const { app, repo, gateway } = await buildApp();
    repo.seedTask({ id: 'net-2', kind: 'network', networkType: 'red', networkSiteName: null, title: 'Tarea sin nodo' });

    const res = await request(app).post('/api/scheduling/net-2/broadcast-noc').set('Cookie', AUTH_COOKIE).send({});

    expect(res.status).toBe(200);
    expect(gateway.sent[0]).toBe(`📧 [Red] Tarea sin nodo\n🔗 ${BASE}/admin/scheduling/tasks/net-2`);
  });

  it('customer task → 422 TASK_NOT_BROADCASTABLE, nothing sent', async () => {
    const { app, repo, gateway } = await buildApp();
    repo.seedTask({ id: 'cust-1', kind: 'customer', title: 'Visita cliente' });

    const res = await request(app).post('/api/scheduling/cust-1/broadcast-noc').set('Cookie', AUTH_COOKIE).send({});

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('TASK_NOT_BROADCASTABLE');
    expect(gateway.sent).toHaveLength(0);
  });

  it('nonexistent task → 404 TASK_NOT_FOUND', async () => {
    const { app } = await buildApp();
    const res = await request(app).post('/api/scheduling/does-not-exist/broadcast-noc').set('Cookie', AUTH_COOKIE).send({});
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });

  it('engine not configured → 503 NOC_BROADCAST_NOT_CONFIGURED', async () => {
    const { app, repo, gateway } = await buildApp();
    repo.seedTask({ id: 'net-3', kind: 'network', networkType: 'red', title: 'X' });
    gateway.error = new NocBroadcastNotConfiguredError();
    const res = await request(app).post('/api/scheduling/net-3/broadcast-noc').set('Cookie', AUTH_COOKIE).send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('NOC_BROADCAST_NOT_CONFIGURED');
  });

  it('Evolution API failure → 502 EVOLUTION_API_ERROR', async () => {
    const { app, repo, gateway } = await buildApp();
    repo.seedTask({ id: 'net-4', kind: 'network', networkType: 'red', title: 'X' });
    gateway.error = new EvolutionApiError('connect ECONNREFUSED');
    const res = await request(app).post('/api/scheduling/net-4/broadcast-noc').set('Cookie', AUTH_COOKIE).send({});
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('EVOLUTION_API_ERROR');
  });

  it('denied by the scheduling:write gate → 403, nothing sent', async () => {
    const { app, repo, gateway } = await buildApp({ write: deny });
    repo.seedTask({ id: 'net-5', kind: 'network', networkType: 'red', title: 'X' });
    const res = await request(app).post('/api/scheduling/net-5/broadcast-noc').set('Cookie', AUTH_COOKIE).send({});
    expect(res.status).toBe(403);
    expect(gateway.sent).toHaveLength(0);
  });

  it('without auth cookie → 401', async () => {
    const { app, repo } = await buildApp();
    repo.seedTask({ id: 'net-6', kind: 'network', networkType: 'red', title: 'X' });
    const res = await request(app).post('/api/scheduling/net-6/broadcast-noc').send({});
    expect(res.status).toBe(401);
  });
});
