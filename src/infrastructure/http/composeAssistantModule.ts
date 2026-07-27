import { Router, type RequestHandler } from 'express';
import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { PermissionAction, RbacModuleCode } from '@domain/entities/rbac';
import { CreateAssistantProfile } from '@application/use-cases/assistant/CreateAssistantProfile';
import { UpdateAssistantProfile } from '@application/use-cases/assistant/UpdateAssistantProfile';
import { GetAssistantConfig } from '@application/use-cases/assistant/GetAssistantConfig';
import { CreateAssistantIntent } from '@application/use-cases/assistant/CreateAssistantIntent';
import { UpdateAssistantIntent } from '@application/use-cases/assistant/UpdateAssistantIntent';
import { DeleteAssistantIntent } from '@application/use-cases/assistant/DeleteAssistantIntent';
import { ListAssistantCatalogs } from '@application/use-cases/assistant/ListAssistantCatalogs';
import { ListAssistantRuns } from '@application/use-cases/assistant/ListAssistantRuns';
import { GetAssistantProviderConfig } from '@application/use-cases/assistant/GetAssistantProviderConfig';
import { UpdateAssistantProviderConfig } from '@application/use-cases/assistant/UpdateAssistantProviderConfig';
import { TestAssistantConnection } from '@application/use-cases/assistant/TestAssistantConnection';
import { PrismaAssistantProviderConfigRepository } from '@infrastructure/adapters/prisma/PrismaAssistantProviderConfigRepository';
import { HttpDeepSeekAssistant } from '@infrastructure/adapters/deepseek/HttpDeepSeekAssistant';
import { config } from '@infrastructure/config';
import { PrismaAssistantRunRepository } from '@infrastructure/adapters/prisma/PrismaAssistantRunRepository';
import {
  PrismaAssistantIntentRepository,
  PrismaAssistantProfileRepository,
} from '@infrastructure/adapters/prisma/PrismaAssistantProfileRepository';
import { PrismaAssistantCatalogRepository } from '@infrastructure/adapters/prisma/PrismaAssistantCatalogRepository';
import { PrismaAssistantEvalRepository } from '@infrastructure/adapters/prisma/PrismaAssistantEvalRepository';
import { createAssistantRouter } from './routes/assistant.routes';
import { createAuthMiddleware } from './middleware/authMiddleware';

export interface ComposeAssistantModuleDeps {
  authAdapter: AuthProvider;
  sessionRepo: SessionRepository;
  /** El `requirePerm` de app.ts, INYECTADO — no re-derivado acá (un solo rbacUserRepo). */
  requirePerm: (module: RbacModuleCode, action: PermissionAction) => RequestHandler;
}

/**
 * ai-assistant-multiagent — wiring del módulo de CONFIGURACIÓN del asistente, en un solo
 * lugar y fuera del cuerpo de `app.ts` (mismo criterio que `composeAlertsModule`).
 *
 * ⚠️ Este módulo cablea SÓLO la configuración. El MOTOR (`ReplyWithAssistant`) se engancha
 * en `ReceiveChatwootWebhook` y se cablea aparte (Batch 6) — separarlos es deliberado: la
 * config puede estar viva y editándose mientras el motor sigue apagado por el flag
 * `ai-assistant-enabled` (dark launch).
 *
 * `NoEvalRecordedGate` es el gate EVAL-2 por defecto: sin corridas de eval registradas, las
 * acciones `red` no se pueden habilitar. Se reemplaza en el Batch 8 por el gate real.
 */
export function composeAssistantModule(deps: ComposeAssistantModuleDeps): Router {
  const profileRepo = new PrismaAssistantProfileRepository();
  const intentRepo = new PrismaAssistantIntentRepository();
  const catalogRepo = new PrismaAssistantCatalogRepository();
  // EVAL-2 — gate REAL (Batch 8): consulta las corridas persistidas. Reemplaza al
  // `NoEvalRecordedGate`, que era el placeholder fail-closed mientras el eval no existía.
  const evalGate = new PrismaAssistantEvalRepository();
  const providerRepo = new PrismaAssistantProviderConfigRepository();
  const envCredentials = { baseUrl: config.assistant.baseUrl, apiKey: config.assistant.apiKey };

  return createAssistantRouter({
    createProfile: new CreateAssistantProfile(profileRepo),
    updateProfile: new UpdateAssistantProfile(profileRepo, catalogRepo, evalGate),
    getConfig: new GetAssistantConfig(profileRepo, intentRepo),
    createIntent: new CreateAssistantIntent(profileRepo, intentRepo, catalogRepo),
    updateIntent: new UpdateAssistantIntent(intentRepo, catalogRepo),
    deleteIntent: new DeleteAssistantIntent(intentRepo),
    listCatalogs: new ListAssistantCatalogs(catalogRepo),
    listRuns: new ListAssistantRuns(new PrismaAssistantRunRepository()),
    getProviderConfig: new GetAssistantProviderConfig(providerRepo, envCredentials),
    updateProviderConfig: new UpdateAssistantProviderConfig(providerRepo, envCredentials),
    // La prueba construye un adapter EFÍMERO con las credenciales resueltas: verifica lo que
    // realmente se va a usar, no un ping inventado.
    testConnection: new TestAssistantConnection(
      providerRepo,
      envCredentials,
      (credentials) =>
        new HttpDeepSeekAssistant({
          baseUrl: credentials.baseUrl,
          apiKey: credentials.apiKey,
          timeoutMs: config.assistant.timeoutMs,
        }),
      'deepseek-chat',
    ),
    auth: createAuthMiddleware(deps.authAdapter, deps.sessionRepo),
    requirePerm: deps.requirePerm,
  });
}
