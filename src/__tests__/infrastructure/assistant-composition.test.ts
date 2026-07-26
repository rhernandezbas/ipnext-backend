import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * ai-assistant-multiagent (T6.3) — composition-root test.
 *
 * ⚠️ **Por qué existe.** En la Wave 6 del EPIC #38 las rutas quedaron cableadas pero el hook
 * nunca se inyectó en `app.ts`: los params eran opcionales, los tests inyectan su propio
 * wiring, y el resultado fue **CI verde con la feature MUERTA en producción**. Ningún test de
 * unidad ni de ruta puede cazar eso — el único que puede es uno que mire el composition root.
 *
 * Estas assertions son estáticas sobre el TEXTO del fuente a propósito: importar `app.ts`
 * levantaría media aplicación (Prisma, schedulers, adapters HTTP) y el test dejaría de ser
 * barato y determinístico. Es feo y es el precio correcto.
 *
 * Si un refactor mueve estas líneas, este test debe ACTUALIZARSE, nunca borrarse: el día que
 * se borre, el próximo hook huérfano llega a prod sin que nadie se entere.
 */

const APP_SOURCE = readFileSync(
  join(__dirname, '../../infrastructure/http/app.ts'),
  'utf-8',
);

const ENGINE_SOURCE = readFileSync(
  join(__dirname, '../../infrastructure/http/composeAssistantEngine.ts'),
  'utf-8',
);

describe('composition root — configuración del asistente', () => {
  it('el router de config está MONTADO en /api/assistant', () => {
    expect(APP_SOURCE).toMatch(/app\.use\(\s*['"]\/api\/assistant['"]\s*,\s*composeAssistantModule/);
  });

  it('composeAssistantModule está importado', () => {
    expect(APP_SOURCE).toContain("from './composeAssistantModule'");
  });
});

describe('composition root — MOTOR del asistente (el bug W6)', () => {
  it('el motor se CONSTRUYE en app.ts', () => {
    expect(APP_SOURCE).toMatch(/const\s+assistantEngine\s*=\s*composeAssistantEngine\(/);
  });

  it('el motor se INYECTA en ReceiveChatwootWebhook — sin esto la feature está muerta', () => {
    // El corazón del test: el motor puede existir, compilar y tener 200 tests verdes, y no
    // servir para nada si nadie lo llama.
    const construction = APP_SOURCE.match(/new ReceiveChatwootWebhook\(([^)]*)\)/);

    expect(construction).not.toBeNull();
    expect(construction?.[1]).toContain('assistantEngine');
  });

  it('el motor recibe el lector de hilo y el resolver de cliente', () => {
    expect(APP_SOURCE).toContain('new ChatMessageThreadReader(');
    expect(APP_SOURCE).toContain('new CustomerAssistantClientResolver(');
  });
});

describe('composition root — resolvers de datos registrados', () => {
  it('registra exactamente los 3 resolvers implementados', () => {
    for (const resolver of [
      'ClienteSaldoResolver',
      'ClienteServicioResolver',
      'OsAbiertasResolver',
    ]) {
      expect(ENGINE_SOURCE).toContain(`new ${resolver}(`);
    }
  });

  it('NO registra un resolver para noc.cortes', () => {
    // Deliberado (design D2): no existe mapeo confiable cliente→zona→alerta, y un resolver
    // que adivinara respondería "no hay cortes" sin respaldo — el modo de falla que este
    // change combate. El catálogo la tiene deshabilitada; las dos capas coinciden.
    expect(ENGINE_SOURCE).not.toMatch(/NocCortes\w*Resolver/);
  });

  it('el adapter de DeepSeek se cablea con la config, no con literales', () => {
    expect(ENGINE_SOURCE).toContain('new HttpDeepSeekAssistant(');
    expect(ENGINE_SOURCE).toContain('config.assistant.apiKey');
  });

  it('la salida va por los use cases de siempre (RUN-3), no por un camino propio', () => {
    expect(ENGINE_SOURCE).toContain('ChatwootAssistantConversationGateway');
    expect(ENGINE_SOURCE).toContain('deps.sendMessage');
    expect(ENGINE_SOURCE).toContain('deps.setConversationArea');
  });
});

describe('composition root — arranca en modo oscuro', () => {
  it('el flag global se llama ai-assistant-enabled y la migración lo siembra en false', () => {
    const migration = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261023000000_ai_assistant_multiagent/migration.sql',
      ),
      'utf-8',
    );

    expect(migration).toMatch(/VALUES\s*\(\s*'ai-assistant-enabled'\s*,\s*false/);
  });

  it('el ruteo arranca SIN área default — nadie atiende hasta que se configure', () => {
    const migration = readFileSync(
      join(
        __dirname,
        '../../../prisma/migrations/20261023000000_ai_assistant_multiagent/migration.sql',
      ),
      'utf-8',
    );

    expect(migration).toMatch(/INSERT INTO "AssistantRoutingConfig"[\s\S]*?NULL/);
  });

  it('ninguna acción de riesgo viene habilitada (enabledActions nace vacío)', () => {
    const schema = readFileSync(join(__dirname, '../../../prisma/schema.prisma'), 'utf-8');

    expect(schema).toMatch(/enabledActions\s+String\[\]\s+@default\(\[\]\)/);
  });
});
