/**
 * fix/auth-stateful-routers — source pin: app.ts must forward the REAL production
 * `sessionRepo` (not `undefined`, not omitted) to every one of the ~36 router
 * factories fixed in this change.
 *
 * `statefulAuthRoutes.revokedSession.test.ts` proves each factory's OWN internal
 * wiring is correct (it forwards whatever `sessionRepo` it receives into
 * `createAuthMiddleware`). That test constructs the router directly and supplies its
 * own `InMemorySessionRepository` — it says nothing about what app.ts actually passes
 * in PRODUCTION. This test closes that gap: it reads the real `src/infrastructure/http/app.ts`
 * source and asserts each mount's argument list contains the `sessionRepo` identifier
 * (the module-level `const sessionRepo = new PrismaSessionRepository()` instantiated
 * once near the top of `createApp`), not a literal `undefined`.
 *
 * Same "two-layer" pattern as `settingsMountAuth.test.ts`'s C2 source pin, generalized
 * to every router this change touched, parametrized so a broken mount is reported by
 * name.
 *
 * Revert-probe: change any ONE of these `app.ts` mounts back to omit `sessionRepo`
 * (or pass `undefined`) and ONLY that router's entry here goes red.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const APP_TS_PATH = join(__dirname, '..', '..', 'infrastructure', 'http', 'app.ts');
const appSrc = readFileSync(APP_TS_PATH, 'utf8');

/** Balanced-paren extraction of a `fnName(...)` call's argument text — app.ts call
 * sites nest other calls (`requirePerm('a','b')`, `new Foo(...)`) so a naive
 * non-greedy match to the first `)` is not safe here (unlike the simpler routes/
 * scanner, where call sites are always bare identifiers). */
function extractCallArgs(src: string, fnName: string): string {
  const marker = fnName + '(';
  const idx = src.indexOf(marker);
  if (idx === -1) throw new Error(`${fnName}( not found in app.ts`);
  const openParenIdx = idx + fnName.length;
  let depth = 0;
  let i = openParenIdx;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`${fnName}(...) call in app.ts never closes (unbalanced parens)`);
  return src.slice(openParenIdx + 1, i);
}

/** Factories mounted with plain positional args: `authAdapter, sessionRepo, ...`. */
const POSITIONAL_FACTORIES = [
  'createContractTechnologiesRouter',
  'createContractServicesRouter',
  'createContractsRouter',
  'createClientsRouter',
  'createBillingRouter',
  'createIClassStatusesRouter',
  'createIClassDispatchPreviewRouter',
  'createIClassClosureRouter',
  'createIClassAdminRouter',
  'createGrVendedorMappingsRouter',
  'createGrSyncRouter',
  'createGestionRealSyncRouter',
  'createGestionRealIngestRouter',
  'createGestionRealRouter',
  'createFeatureFlagsRouter',
  'createDeviceTypeCatalogRouter',
  'createMaterialTypeCatalogRouter',
  'createIClassTechnicianTeamsRouter',
  'createIClassTeamsRouter',
  'createMessagingLabelsRouter',
  'createNewsRouter',
  'createNocBroadcastRouter',
  'createProjectsRouter',
  'createServiceCatalogRouter',
  'createSchedulingRouter',
  'createTaskStageConfigRouter',
  'createTaskPrioritiesRouter',
  'createTaskCategoriesRouter',
  'createTaskTemplateRouter',
  'createTicketAreasRouter',
  'createWorkflowsRouter',
  'createTicketStatusesRouter',
  'createTicketSlaConfigRouter',
  'createTicketsRouter',
];

/** Factories mounted with a `deps` object literal containing `sessionRepo,` (shorthand). */
const DEPS_OBJECT_FACTORIES = ['createNewsMediaRouter', 'createTaskAttachmentsRouter'];

describe('fix/auth-stateful-routers — app.ts source pin: every migrated mount forwards the real sessionRepo', () => {
  it.each(POSITIONAL_FACTORIES.map((f) => [f] as const))('%s: app.ts mount includes sessionRepo, not undefined', (fnName) => {
    const args = extractCallArgs(appSrc, fnName);
    expect(args).toMatch(/\bsessionRepo\b/);
    // Guard against a sneaky `sessionRepo: undefined` or a shadowed local named
    // `sessionRepo` that isn't the real module-level instance — the real usage here
    // is always the bare identifier as a positional arg, never `sessionRepo:`.
    expect(args).not.toMatch(/\bsessionRepo\s*:\s*undefined\b/);
  });

  it.each(DEPS_OBJECT_FACTORIES.map((f) => [f] as const))('%s: app.ts mount deps object includes sessionRepo, not undefined', (fnName) => {
    const args = extractCallArgs(appSrc, fnName);
    expect(args).toMatch(/\bsessionRepo\b/);
    expect(args).not.toMatch(/\bsessionRepo\s*:\s*undefined\b/);
  });

  it('every factory above is mounted EXACTLY ONCE in app.ts (a duplicate mount could hide an unfixed copy)', () => {
    const all = [...POSITIONAL_FACTORIES, ...DEPS_OBJECT_FACTORIES];
    for (const fnName of all) {
      const occurrences = appSrc.split(fnName + '(').length - 1;
      expect({ fnName, occurrences }).toEqual({ fnName, occurrences: 1 });
    }
  });
});
