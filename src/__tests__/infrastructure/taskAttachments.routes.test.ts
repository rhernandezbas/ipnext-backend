/**
 * Integration tests para el sub-router de adjuntos (fotos) de tarea.
 * Auth: EchoAuthProvider (cookie token = userId) + InMemory RBAC repos.
 * Gates: scheduling:read (GET) y scheduling:write (POST/DELETE).
 */
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';

import { InMemoryFileStorage } from '@infrastructure/adapters/in-memory/InMemoryFileStorage';
import { InMemoryTaskAttachmentRepository } from '@infrastructure/adapters/in-memory/InMemoryTaskAttachmentRepository';
import { InMemoryRbacUserRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRepository';
import { InMemoryRbacRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRoleRepository';
import { InMemoryRbacUserRoleRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacUserRoleRepository';
import { InMemoryRbacPermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacPermissionRepository';
import { InMemoryRbacRolePermissionRepository } from '@infrastructure/adapters/in-memory/InMemoryRbacRolePermissionRepository';
import { InMemoryPasswordHasher } from '@infrastructure/adapters/in-memory/InMemoryPasswordHasher';

import { requirePermission } from '@infrastructure/http/middleware/requirePermission';
import { errorHandler } from '@infrastructure/http/middleware/errorHandler';
import { createTaskAttachmentsRouter } from '@infrastructure/http/routes/taskAttachments.routes';

import { AttachPhotosToTask } from '@application/use-cases/AttachPhotosToTask';
import { ListTaskAttachments } from '@application/use-cases/ListTaskAttachments';
import { GetTaskAttachmentFile } from '@application/use-cases/GetTaskAttachmentFile';
import { DeleteTaskAttachment } from '@application/use-cases/DeleteTaskAttachment';

import { AuthProvider } from '@domain/ports/AuthProvider';
import { User } from '@domain/entities/auth';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ImageProcessor, ProcessedImage, ImageDimensions } from '@domain/ports/ImageProcessor';
import { createScheduledTaskAttachment } from '@domain/entities/scheduledTaskAttachment';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

class EchoAuthProvider implements AuthProvider {
  async login() {
    return {
      user: { id: 'x', username: 't', email: 't@t.com', role: 'admin' as const },
      cookieValue: 'x',
      cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 3600, path: '/' },
    };
  }
  logout() {
    return { cookieOptions: { httpOnly: true, secure: false, sameSite: 'lax' as const, maxAge: 0, path: '/' } };
  }
  async getSession(token: string): Promise<User> {
    return { id: token, username: 'test', email: 'test@test.com', role: 'admin' };
  }
}

class StubImageProcessor implements ImageProcessor {
  async process(): Promise<ProcessedImage> {
    return { width: 800, height: 600, thumbnail: Buffer.from('thumb-bytes') };
  }
  inspect(): ImageDimensions | null {
    return { width: 800, height: 600, type: 'jpg' };
  }
}

const taskLookup: EntityLookup = { findById: async (id: string) => (id === 't1' ? { id } : null) };

async function buildRbac() {
  const roleRepo = new InMemoryRbacRoleRepository();
  const userRoleRepo = new InMemoryRbacUserRoleRepository();
  const permRepo = new InMemoryRbacPermissionRepository();
  const rolePermRepo = new InMemoryRbacRolePermissionRepository();
  const hasher = new InMemoryPasswordHasher();
  const userRepo = new InMemoryRbacUserRepository(userRoleRepo, roleRepo);

  userRepo.listRolesForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const roles = await Promise.all(roleIds.map((id) => roleRepo.findById(id)));
    return roles.filter((r): r is NonNullable<typeof r> => r !== null);
  };
  userRepo.listPermissionsForUser = async (userId: string) => {
    const roleIds = await userRoleRepo.listForUser(userId);
    const perms: import('@domain/entities/rbac').RbacPermission[] = [];
    const allPerms = await permRepo.listAll();
    for (const roleId of roleIds) {
      const permIds = await rolePermRepo.listForRole(roleId);
      for (const permId of permIds) {
        const p = allPerms.find((ap) => ap.id === permId);
        if (p) perms.push(p);
      }
    }
    return perms;
  };

  const schedRole = await roleRepo.create({ code: 'sched_role', label: 'Scheduling', isSystem: false });
  const readPerm = await permRepo.seed({ moduleCode: 'scheduling', action: 'read' });
  const writePerm = await permRepo.seed({ moduleCode: 'scheduling', action: 'write' });
  await rolePermRepo.grant(schedRole.id, readPerm.id);
  await rolePermRepo.grant(schedRole.id, writePerm.id);

  const pwHash = await hasher.hash('pw');
  const mkUser = (login: string) =>
    userRepo.create({ name: login, email: `${login}@x.com`, login, passwordHash: pwHash, status: 'active' });

  const fullUser = await mkUser('full');
  await userRoleRepo.assign(fullUser.id, schedRole.id);
  const noPermUser = await mkUser('noperm');

  const requirePerm = (m: RbacModuleCode, a: PermissionAction) => requirePermission(userRepo, m, a);
  return { requirePerm, fullUserId: fullUser.id, noPermUserId: noPermUser.id };
}

async function buildApp(opts: { mountSchedulingCatchAll?: boolean } = {}) {
  const { requirePerm, fullUserId, noPermUserId } = await buildRbac();
  const repo = new InMemoryTaskAttachmentRepository();
  const storage = new InMemoryFileStorage();

  const router = createTaskAttachmentsRouter(
    {
      attachPhotosToTask: new AttachPhotosToTask(repo, storage, taskLookup, new StubImageProcessor()),
      listTaskAttachments: new ListTaskAttachments(repo),
      getTaskAttachmentFile: new GetTaskAttachmentFile(repo, storage),
      deleteTaskAttachment: new DeleteTaskAttachment(repo, storage),
    },
    {
      authProvider: new EchoAuthProvider(),
      sessionRepo: undefined,
      requireRead: requirePerm('scheduling', 'read'),
      requireWrite: requirePerm('scheduling', 'write'),
    },
  );

  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/scheduling', router);
  // Monta un catch-all GET /:id real (como el scheduling router de app.ts) para verificar
  // que GET /attachments/:id/file devuelve el binario AUNQUE haya un catch-all presente.
  // Nota: el orden de montaje NO afecta — los paths son disjuntos por nº de segmentos
  // (3 vs 2 vs 1), así que GET /:id no puede capturar /attachments/:id/file en ningún orden.
  if (opts.mountSchedulingCatchAll) {
    const sched = express.Router();
    sched.get('/:id', (req, res) => {
      res.json({ id: req.params['id'], kind: 'task-json-catch-all' });
    });
    app.use('/api/scheduling', sched);
  }
  app.use(errorHandler);

  return { app, repo, storage, fullUserId, noPermUserId };
}

const asUser = (req: request.Test, userId: string): request.Test => req.set('Cookie', `auth_token=${userId}`);

describe('POST /api/scheduling/:taskId/attachments', () => {
  it('sin token → 401', async () => {
    const { app } = await buildApp();
    const res = await request(app)
      .post('/api/scheduling/t1/attachments')
      .attach('photos', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(401);
  });

  it('con token pero sin scheduling:write → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(
      request(app)
        .post('/api/scheduling/t1/attachments')
        .attach('photos', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'a.jpg', contentType: 'image/jpeg' }),
      noPermUserId,
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('con scheduling:write y multipart → 201 con array de DTOs (fileUrl/thumbUrl, sin storageKey)', async () => {
    const { app, fullUserId } = await buildApp();
    const res = await asUser(
      request(app)
        .post('/api/scheduling/t1/attachments')
        .attach('photos', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'a.jpg', contentType: 'image/jpeg' }),
      fullUserId,
    );
    expect(res.status).toBe(201);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    const dto = res.body[0];
    expect(dto.taskId).toBe('t1');
    expect(dto.filename).toBe('a.jpg');
    expect(dto.fileUrl).toBe(`/api/scheduling/attachments/${dto.id}/file`);
    expect(dto.thumbUrl).toBe(`/api/scheduling/attachments/${dto.id}/file?variant=thumb`);
    expect(dto.storageKey).toBeUndefined();
  });

  it('tarea inexistente → 404 TASK_NOT_FOUND', async () => {
    const { app, fullUserId } = await buildApp();
    const res = await asUser(
      request(app)
        .post('/api/scheduling/ghost/attachments')
        .attach('photos', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'a.jpg', contentType: 'image/jpeg' }),
      fullUserId,
    );
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('TASK_NOT_FOUND');
  });

  it('mimetype no soportado → 415 UNSUPPORTED_ATTACHMENT_TYPE', async () => {
    const { app, fullUserId } = await buildApp();
    const res = await asUser(
      request(app)
        .post('/api/scheduling/t1/attachments')
        .attach('photos', Buffer.from('pdf-bytes'), { filename: 'doc.pdf', contentType: 'application/pdf' }),
      fullUserId,
    );
    expect(res.status).toBe(415);
    expect(res.body.code).toBe('UNSUPPORTED_ATTACHMENT_TYPE');
  });
});

describe('GET + DELETE attachment endpoints', () => {
  async function createOne(app: express.Express, userId: string) {
    const res = await asUser(
      request(app)
        .post('/api/scheduling/t1/attachments')
        .attach('photos', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'a.jpg', contentType: 'image/jpeg' }),
      userId,
    );
    return res.body[0];
  }

  it('GET /:taskId/attachments con scheduling:read → 200 array', async () => {
    const { app, fullUserId } = await buildApp();
    await createOne(app, fullUserId);
    const res = await asUser(request(app).get('/api/scheduling/t1/attachments'), fullUserId);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('GET /:taskId/attachments sin token → 401', async () => {
    const { app } = await buildApp();
    const res = await request(app).get('/api/scheduling/t1/attachments');
    expect(res.status).toBe(401);
  });

  it('GET /attachments/:id/file → 200 con content-type del original (no shadoweada por /:id)', async () => {
    const { app, fullUserId } = await buildApp();
    const dto = await createOne(app, fullUserId);
    const res = await asUser(request(app).get(`/api/scheduling/attachments/${dto.id}/file`), fullUserId);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.headers['content-disposition']).toContain('inline');
  });

  it('GET /attachments/:id/file?variant=thumb → 200 con el thumbnail', async () => {
    const { app, fullUserId } = await buildApp();
    const dto = await createOne(app, fullUserId);
    const res = await asUser(request(app).get(`/api/scheduling/attachments/${dto.id}/file?variant=thumb`), fullUserId);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('thumb-bytes');
  });

  it('GET /attachments/:id/file inexistente → 404 ATTACHMENT_NOT_FOUND', async () => {
    const { app, fullUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/scheduling/attachments/ghost/file'), fullUserId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('ATTACHMENT_NOT_FOUND');
  });

  it('DELETE /attachments/:id con scheduling:write → 204', async () => {
    const { app, fullUserId } = await buildApp();
    const dto = await createOne(app, fullUserId);
    const res = await asUser(request(app).delete(`/api/scheduling/attachments/${dto.id}`), fullUserId);
    expect(res.status).toBe(204);
    const list = await asUser(request(app).get('/api/scheduling/t1/attachments'), fullUserId);
    expect(list.body).toHaveLength(0);
  });

  it('DELETE /attachments/:id sin scheduling:write → 403', async () => {
    const { app, fullUserId, noPermUserId } = await buildApp();
    const dto = await createOne(app, fullUserId);
    const res = await asUser(request(app).delete(`/api/scheduling/attachments/${dto.id}`), noPermUserId);
    expect(res.status).toBe(403);
  });
});

// ── A3: tests falsificables ───────────────────────────────────────────────────

describe('A3 — orden de rutas REAL (catch-all GET /:id montado después, como en app.ts)', () => {
  it('GET /attachments/:id/file devuelve el BINARIO, NO el JSON de tarea del catch-all', async () => {
    const { app, repo, storage, fullUserId } = await buildApp({ mountSchedulingCatchAll: true });
    const att = await repo.create(
      createScheduledTaskAttachment({
        id: 'real-1',
        taskId: 't1',
        storageKey: 'tasks/t1/real-1.jpg',
        filename: 'real.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 8,
        uploadedById: 'u1',
      }),
    );
    await storage.save({ key: att.storageKey, buffer: Buffer.from('BINARYDT'), mimeType: 'image/jpeg' });

    const res = await asUser(request(app).get(`/api/scheduling/attachments/${att.id}/file`), fullUserId);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.body.toString()).toBe('BINARYDT');
    // y NO el JSON del catch-all
    expect(res.body.kind).toBeUndefined();
  });

  it('sanity: una ruta NO-attachments SÍ cae en el catch-all (devuelve el JSON de tarea)', async () => {
    const { app, fullUserId } = await buildApp({ mountSchedulingCatchAll: true });
    const res = await asUser(request(app).get('/api/scheduling/some-task-id'), fullUserId);
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('task-json-catch-all');
  });
});

describe('A3 — límites de multer', () => {
  it('archivo > 10 MiB → 413 FILE_TOO_LARGE', async () => {
    const { app, fullUserId } = await buildApp();
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0x41);
    const res = await asUser(
      request(app)
        .post('/api/scheduling/t1/attachments')
        .attach('photos', big, { filename: 'big.jpg', contentType: 'image/jpeg' }),
      fullUserId,
    );
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('FILE_TOO_LARGE');
  });

  it('16 archivos → 400 TOO_MANY_FILES', async () => {
    const { app, fullUserId } = await buildApp();
    let req = request(app).post('/api/scheduling/t1/attachments');
    for (let i = 0; i < 16; i++) {
      req = req.attach('photos', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: `f${i}.jpg`, contentType: 'image/jpeg' });
    }
    const res = await asUser(req, fullUserId);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOO_MANY_FILES');
  });
});

describe('A3 — 0 archivos', () => {
  it('POST sin archivos → 400 NO_FILES', async () => {
    const { app, fullUserId } = await buildApp();
    const res = await asUser(
      request(app).post('/api/scheduling/t1/attachments').field('foo', 'bar'),
      fullUserId,
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_FILES');
  });
});

describe('A3 — 403 de LECTURA (scheduling.read)', () => {
  it('GET /:taskId/attachments sin scheduling:read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/scheduling/t1/attachments'), noPermUserId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });

  it('GET /attachments/:id/file sin scheduling:read → 403', async () => {
    const { app, noPermUserId } = await buildApp();
    const res = await asUser(request(app).get('/api/scheduling/attachments/whatever/file'), noPermUserId);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
  });
});

// ── M5: Content-Disposition seguro (RFC 5987) ─────────────────────────────────

describe('M5 — Content-Disposition con filename no-ASCII (RFC 5987)', () => {
  it('filename "café☕.jpg" → 200 con header válido (no 500 ERR_INVALID_CHAR)', async () => {
    const { app, repo, storage, fullUserId } = await buildApp();
    const att = await repo.create(
      createScheduledTaskAttachment({
        id: 'utf-1',
        taskId: 't1',
        storageKey: 'tasks/t1/utf-1.jpg',
        filename: 'café☕.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 4,
        uploadedById: 'u1',
      }),
    );
    await storage.save({ key: att.storageKey, buffer: Buffer.from('DATA'), mimeType: 'image/jpeg' });

    const res = await asUser(request(app).get(`/api/scheduling/attachments/${att.id}/file`), fullUserId);

    expect(res.status).toBe(200);
    const cd = res.headers['content-disposition'];
    expect(cd).toContain('inline');
    // ascii fallback sanitizado (no caracteres no-ASCII en la parte filename="...")
    expect(cd).toMatch(/filename="[\x20-\x7E]*"/);
    // y el filename* RFC 5987 con el nombre real percent-encoded
    expect(cd).toContain(`filename*=UTF-8''${encodeURIComponent('café☕.jpg')}`);
  });

  it('filename con comillas/CRLF → header válido sin romper (no 500)', async () => {
    const { app, repo, storage, fullUserId } = await buildApp();
    const att = await repo.create(
      createScheduledTaskAttachment({
        id: 'crlf-1',
        taskId: 't1',
        storageKey: 'tasks/t1/crlf-1.jpg',
        filename: 'a"b\r\nc.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 4,
        uploadedById: 'u1',
      }),
    );
    await storage.save({ key: att.storageKey, buffer: Buffer.from('DATA'), mimeType: 'image/jpeg' });

    const res = await asUser(request(app).get(`/api/scheduling/attachments/${att.id}/file`), fullUserId);

    expect(res.status).toBe(200);
    const cd = res.headers['content-disposition'];
    // sin comillas crudas ni CR/LF dentro del fallback ascii
    expect(cd).toMatch(/filename="[\x20-\x7E]*"/);
    expect(cd).not.toMatch(/[\r\n]/);
  });
});
