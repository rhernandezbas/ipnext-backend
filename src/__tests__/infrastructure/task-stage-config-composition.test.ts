/**
 * bulk-task-recipients (B6.2, D6, D9) — composition-root static guard for
 * `/api/messaging/config/task-stages`. Booting createApp() needs a live DB
 * (same constraint documented in `ticket-comments-composition.test.ts` /
 * `task-general-status-composition.test.ts` / `messaging-bulk-composition.test.ts`)
 * — this asserts the wiring statically by reading `app.ts` source, same
 * pattern as those files. The functional behavior of the router itself (GET/PUT,
 * gates, Zod 400, stageId inexistente → 422) is already covered by
 * `taskStageConfig.routes.test.ts` (Batch 3, supertest + in-memory repo) — this
 * file only pins that `app.ts` REALLY mounts it, at the right path, with the
 * right gates (anti-W6: sin esto el 5to dominio queda inalcanzable en prod
 * aunque el router y los use cases existan).
 *
 * Pins:
 *  1) `createTaskStageConfigRouter` importado + montado en
 *     `/api/messaging/config/task-stages` (prefijo MÁS específico que
 *     `/api/messaging`, mismo fall-through que `/noc-broadcast`).
 *  2) `GetTaskStageRecipientConfig`/`UpdateTaskStageRecipientConfig` wired con
 *     una instancia del repo de config dentro de la MISMA llamada de mount.
 *  3) Gates `messaging.read` (GET) / `messaging.manage` (PUT) aplicados dentro
 *     de la ventana de mount.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Task-stage recipient config composition root (bulk-task-recipients, B6)', () => {
  let appSrc: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
  });

  it('(a) createTaskStageConfigRouter está importado desde ./routes/taskStageConfig.routes', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*createTaskStageConfigRouter\s*\}\s*from\s*['"]\.\/routes\/taskStageConfig\.routes['"]/,
    );
  });

  it("(b) router montado en '/api/messaging/config/task-stages' (no 404 — GET/PUT responden)", () => {
    expect(appSrc).toMatch(
      /app\.use\(\s*['"]\/api\/messaging\/config\/task-stages['"]\s*,\s*createTaskStageConfigRouter\(/,
    );
  });

  it('(c) GetTaskStageRecipientConfig/UpdateTaskStageRecipientConfig wired dentro de la MISMA llamada de mount', () => {
    const idx = appSrc.indexOf("app.use('/api/messaging/config/task-stages', createTaskStageConfigRouter(");
    expect(idx).toBeGreaterThan(-1);
    const end = appSrc.indexOf('));', idx);
    expect(end).toBeGreaterThan(idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/new GetTaskStageRecipientConfig\(\s*\w+\s*\)/);
    expect(window).toMatch(/new UpdateTaskStageRecipientConfig\(\s*\w+\s*\)/);
  });

  it('(d) gates messaging.read (GET) / messaging.manage (PUT) aplicados dentro de la ventana de mount', () => {
    const idx = appSrc.indexOf("app.use('/api/messaging/config/task-stages', createTaskStageConfigRouter(");
    const end = appSrc.indexOf('));', idx);
    const window = appSrc.slice(idx, end + '));'.length);
    expect(window).toMatch(/read:\s*requirePerm\(\s*['"]messaging['"]\s*,\s*['"]read['"]\s*\)/);
    expect(window).toMatch(/manage:\s*requirePerm\(\s*['"]messaging['"]\s*,\s*['"]manage['"]\s*\)/);
  });

  it('(e) PrismaTaskStageRecipientConfigRepository instanciado (importado y usado para el bloque de config)', () => {
    expect(appSrc).toMatch(
      /import\s*\{\s*PrismaTaskStageRecipientConfigRepository\s*\}\s*from\s*['"]\.\.\/adapters\/prisma\/PrismaTaskStageRecipientConfigRepository['"]/,
    );
    expect(appSrc).toMatch(/new PrismaTaskStageRecipientConfigRepository\(\)/);
  });
});
