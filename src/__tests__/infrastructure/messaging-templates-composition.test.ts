/**
 * Change 3 (templates CRUD, T5) — composition-root pin sobre `app.ts` (molde
 * `messaging-bulk-composition.test.ts`). Anti-"feature muerta en prod" (lección
 * W6): pinea que `createMessagingTemplatesRouter` está importado y montado en
 * `/api/messaging/templates`, con los 5 use cases cableados dentro de la MISMA
 * llamada de mount, el guard `DeleteTemplate` recibiendo el repo de campañas, y
 * los guards RBAC `messaging.bulk` (write) + `messaging.templates` (read) + auth
 * stateful en la ventana de mount.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

describe('Messaging-templates composition root (Change 3, T5)', () => {
  let appSrc: string;
  let mountWindow: string;

  beforeAll(() => {
    appSrc = readFileSync(join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts'), 'utf8');
    const idx = appSrc.indexOf("app.use('/api/messaging/templates', createMessagingTemplatesRouter(");
    const end = appSrc.indexOf('));', idx);
    mountWindow = idx > -1 && end > -1 ? appSrc.slice(idx, end + '));'.length) : '';
  });

  it('(a) createMessagingTemplatesRouter importado desde ./routes/templates.routes', () => {
    expect(appSrc).toMatch(/import\s*\{\s*createMessagingTemplatesRouter\s*\}\s*from\s*['"]\.\/routes\/templates\.routes['"]/);
  });

  it("(b) router montado en '/api/messaging/templates'", () => {
    expect(appSrc).toMatch(/app\.use\(\s*['"]\/api\/messaging\/templates['"]\s*,\s*createMessagingTemplatesRouter\(/);
  });

  it('(c) los 5 use cases cableados dentro de la MISMA llamada de mount', () => {
    expect(mountWindow).not.toBe('');
    expect(mountWindow).toMatch(/new CreateTemplate\(/);
    expect(mountWindow).toMatch(/new ListMessagingTemplates\(/);
    expect(mountWindow).toMatch(/new GetTemplate\(/);
    expect(mountWindow).toMatch(/new SubmitTemplateForApproval\(/);
    expect(mountWindow).toMatch(/new DeleteTemplate\(/);
  });

  it('(d) DeleteTemplate recibe 2 args (adminPort + repo de campañas para el guard)', () => {
    expect(mountWindow).toMatch(/new DeleteTemplate\([^)]*,[^)]*\)/);
  });

  it('(e) guards RBAC messaging.bulk (write) + messaging.templates (read) + auth stateful en la ventana', () => {
    expect(mountWindow).toMatch(/requirePerm\('messaging',\s*'bulk'\)/);
    expect(mountWindow).toMatch(/requirePerm\('messaging',\s*'templates'\)/);
    expect(mountWindow).toMatch(/createAuthMiddleware\(authAdapter,\s*sessionRepo\)/);
  });
});
