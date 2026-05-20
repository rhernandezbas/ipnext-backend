/**
 * Integration tests for checklist sub-routes.
 * Uses InMemory repos and FakeAuthProvider — no real DB needed.
 */
import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { createSchedulingRouter } from '../../infrastructure/http/routes/scheduling.routes';
import { createTaskTemplateRouter } from '../../infrastructure/http/routes/taskTemplate.routes';
import { InMemorySchedulingRepository } from '../../infrastructure/adapters/in-memory/InMemorySchedulingRepository';
import { InMemoryTaskTemplateRepository } from '../../infrastructure/adapters/in-memory/InMemoryTaskTemplateRepository';
import { ListTasks } from '../../application/use-cases/ListTasks';
import { GetTask } from '../../application/use-cases/GetTask';
import { CreateTask } from '../../application/use-cases/CreateTask';
import { UpdateTask } from '../../application/use-cases/UpdateTask';
import { DeleteTask } from '../../application/use-cases/DeleteTask';
import { UpdateTaskStatus } from '../../application/use-cases/UpdateTaskStatus';
import { MoveTaskToStage } from '../../application/use-cases/MoveTaskToStage';
import { AddChecklistItem } from '../../application/use-cases/AddChecklistItem';
import { ToggleChecklistItem } from '../../application/use-cases/ToggleChecklistItem';
import { UpdateChecklistItem } from '../../application/use-cases/UpdateChecklistItem';
import { RemoveChecklistItem } from '../../application/use-cases/RemoveChecklistItem';
import { ReorderChecklistItems } from '../../application/use-cases/ReorderChecklistItems';
import { AssignTemplateToTask } from '../../application/use-cases/AssignTemplateToTask';
import { ClearTaskChecklist } from '../../application/use-cases/ClearTaskChecklist';
import { ReplaceTaskTemplateItems } from '../../application/use-cases/ReplaceTaskTemplateItems';
import { ListTaskTemplates } from '../../application/use-cases/ListTaskTemplates';
import { GetTaskTemplate } from '../../application/use-cases/GetTaskTemplate';
import { CreateTaskTemplate } from '../../application/use-cases/CreateTaskTemplate';
import { UpdateTaskTemplate } from '../../application/use-cases/UpdateTaskTemplate';
import { DeleteTaskTemplate } from '../../application/use-cases/DeleteTaskTemplate';
import { User } from '../../domain/entities/auth';
import { AuthProvider } from '../../domain/ports/AuthProvider';
import { EntityLookup } from '../../domain/ports/EntityLookup';
import { InMemoryStageRepository } from '../../infrastructure/adapters/in-memory/InMemoryStageRepository';

class StubLookup implements EntityLookup {
  async findById(_id: string) { return null; }
}

class FakeAuthProvider implements AuthProvider {
  async login() {
    return { user: { id: 'a-1', username: 't', email: 't@t.com', role: 'admin' as const }, cookieValue: 'fake', cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' } };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(_token: string): Promise<User> {
    return { id: 'a-1', username: 't', email: 't@t.com', role: 'admin' };
  }
}

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());

  const templateRepo = new InMemoryTaskTemplateRepository();
  const schedRepo = new InMemorySchedulingRepository(undefined, templateRepo);
  const stageRepo = new InMemoryStageRepository();
  const authProvider = new FakeAuthProvider();
  const emptyLookup = new StubLookup();

  const checklistUCs = {
    addChecklistItem: new AddChecklistItem(schedRepo),
    toggleChecklistItem: new ToggleChecklistItem(schedRepo),
    updateChecklistItem: new UpdateChecklistItem(schedRepo),
    removeChecklistItem: new RemoveChecklistItem(schedRepo),
    reorderChecklistItems: new ReorderChecklistItems(schedRepo),
    assignTemplateToTask: new AssignTemplateToTask(schedRepo, templateRepo),
    clearTaskChecklist: new ClearTaskChecklist(schedRepo),
  };

  app.use('/api/scheduling', createSchedulingRouter(
    new ListTasks(schedRepo),
    new GetTask(schedRepo),
    new CreateTask(schedRepo, emptyLookup, emptyLookup, emptyLookup, emptyLookup),
    new UpdateTask(schedRepo, emptyLookup, emptyLookup, emptyLookup, emptyLookup),
    new DeleteTask(schedRepo),
    new UpdateTaskStatus(schedRepo, stageRepo),
    new MoveTaskToStage(schedRepo, stageRepo),
    authProvider,
    stageRepo,
    checklistUCs,
  ));

  app.use('/api/task-templates', createTaskTemplateRouter(
    new ListTaskTemplates(templateRepo),
    new GetTaskTemplate(templateRepo),
    new CreateTaskTemplate(templateRepo),
    new UpdateTaskTemplate(templateRepo),
    new DeleteTaskTemplate(templateRepo),
    authProvider,
    new ReplaceTaskTemplateItems(templateRepo),
  ));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return { app, schedRepo, templateRepo };
}

const cookie = 'auth_token=fake';
const EXISTING_TASK_ID = '1'; // seeded in InMemory
const EXISTING_TEMPLATE_ID = '1'; // seeded in InMemory

describe('Checklist routes', () => {
  it('POST /api/scheduling/:id/checklist — 201 with new item', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/scheduling/${EXISTING_TASK_ID}/checklist`)
      .set('Cookie', cookie)
      .send({ text: 'New checklist item' });
    expect(res.status).toBe(201);
    expect(res.body.text).toBe('New checklist item');
    expect(res.body.done).toBe(false);
    expect(res.body.order).toBe(0);
  });

  it('POST /api/scheduling/:id/checklist — 400 on empty text', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/scheduling/${EXISTING_TASK_ID}/checklist`)
      .set('Cookie', cookie)
      .send({ text: '' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('POST /api/scheduling/:id/checklist — 404 for unknown task', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post('/api/scheduling/nonexistent/checklist')
      .set('Cookie', cookie)
      .send({ text: 'Item' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });

  it('POST /api/scheduling/:id/checklist/assign-template — 200 with cloned items', async () => {
    const { app, templateRepo } = buildApp();
    // First add items to template
    await templateRepo.replaceItems(EXISTING_TEMPLATE_ID, [
      { text: 'Step 1' }, { text: 'Step 2' },
    ]);
    const res = await request(app)
      .post(`/api/scheduling/${EXISTING_TASK_ID}/checklist/assign-template`)
      .set('Cookie', cookie)
      .send({ templateId: EXISTING_TEMPLATE_ID });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].text).toBe('Step 1');
  });

  it('POST /api/scheduling/:id/checklist/assign-template — 404 for unknown template', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/scheduling/${EXISTING_TASK_ID}/checklist/assign-template`)
      .set('Cookie', cookie)
      .send({ templateId: 'nonexistent' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });

  it('DELETE /api/scheduling/:id/checklist — 204 clears checklist', async () => {
    const { app, schedRepo } = buildApp();
    await schedRepo.addChecklistItem(EXISTING_TASK_ID, 'To clear');
    const res = await request(app)
      .delete(`/api/scheduling/${EXISTING_TASK_ID}/checklist`)
      .set('Cookie', cookie);
    expect(res.status).toBe(204);
  });

  it('PUT /api/scheduling/:id/checklist/order — 200 with reordered items', async () => {
    const { app, schedRepo } = buildApp();
    const a = await schedRepo.addChecklistItem(EXISTING_TASK_ID, 'A');
    const b = await schedRepo.addChecklistItem(EXISTING_TASK_ID, 'B');
    const res = await request(app)
      .put(`/api/scheduling/${EXISTING_TASK_ID}/checklist/order`)
      .set('Cookie', cookie)
      .send({ orderedIds: [b.id, a.id] });
    expect(res.status).toBe(200);
    expect(res.body[0].id).toBe(b.id);
  });

  it('PUT /api/scheduling/:id/checklist/order — 400 on validation error', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put(`/api/scheduling/${EXISTING_TASK_ID}/checklist/order`)
      .set('Cookie', cookie)
      .send({});
    expect(res.status).toBe(400);
  });

  it('PATCH /api/scheduling/:id/checklist/:itemId/toggle — 200 toggles done', async () => {
    const { app, schedRepo } = buildApp();
    const item = await schedRepo.addChecklistItem(EXISTING_TASK_ID, 'Toggle me');
    const res = await request(app)
      .patch(`/api/scheduling/${EXISTING_TASK_ID}/checklist/${item.id}/toggle`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(true);
  });

  it('PATCH /api/scheduling/:id/checklist/:itemId/toggle — 404 for unknown item', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .patch(`/api/scheduling/${EXISTING_TASK_ID}/checklist/nonexistent/toggle`)
      .set('Cookie', cookie);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('CHECKLIST_ITEM_NOT_FOUND');
  });

  it('PATCH /api/scheduling/:id/checklist/:itemId — 200 updates text', async () => {
    const { app, schedRepo } = buildApp();
    const item = await schedRepo.addChecklistItem(EXISTING_TASK_ID, 'Old text');
    const res = await request(app)
      .patch(`/api/scheduling/${EXISTING_TASK_ID}/checklist/${item.id}`)
      .set('Cookie', cookie)
      .send({ text: 'New text' });
    expect(res.status).toBe(200);
    expect(res.body.text).toBe('New text');
  });

  it('DELETE /api/scheduling/:id/checklist/:itemId — 204 removes item', async () => {
    const { app, schedRepo } = buildApp();
    const item = await schedRepo.addChecklistItem(EXISTING_TASK_ID, 'Remove me');
    const res = await request(app)
      .delete(`/api/scheduling/${EXISTING_TASK_ID}/checklist/${item.id}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(204);
  });

  it('DELETE /api/scheduling/:id/checklist/:itemId — 404 for unknown item', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .delete(`/api/scheduling/${EXISTING_TASK_ID}/checklist/nonexistent`)
      .set('Cookie', cookie);
    expect(res.status).toBe(404);
  });

  it('Returns 401 without cookie on checklist routes', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .post(`/api/scheduling/${EXISTING_TASK_ID}/checklist`)
      .send({ text: 'Item' });
    expect(res.status).toBe(401);
  });
});

describe('Template items route', () => {
  it('PUT /api/task-templates/:id/items — 200 with items', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put(`/api/task-templates/${EXISTING_TEMPLATE_ID}/items`)
      .set('Cookie', cookie)
      .send({ items: [{ text: 'Step A' }, { text: 'Step B' }] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].text).toBe('Step A');
  });

  it('PUT /api/task-templates/:id/items — 400 on invalid text', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put(`/api/task-templates/${EXISTING_TEMPLATE_ID}/items`)
      .set('Cookie', cookie)
      .send({ items: [{ text: '' }] });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('PUT /api/task-templates/:id/items — 404 for unknown template', async () => {
    const { app } = buildApp();
    const res = await request(app)
      .put('/api/task-templates/nonexistent/items')
      .set('Cookie', cookie)
      .send({ items: [{ text: 'Item' }] });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
  });
});
