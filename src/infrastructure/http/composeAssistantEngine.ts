import { config } from '@infrastructure/config';
import type { ConversationRepository } from '@domain/ports/ConversationRepository';
import type { ChatwootGateway } from '@domain/ports/ChatwootGateway';
import type { CustomerRepository } from '@domain/ports/CustomerRepository';
import type { AssistantThreadReader } from '@domain/ports/AssistantThreadReader';
import type { AssistantClientResolver } from '@domain/ports/AssistantClientResolver';
import type { SendMessage } from '@application/use-cases/messaging/SendMessage';
import type { SetConversationArea } from '@application/use-cases/messaging/SetConversationArea';
import type { SetConversationStatus } from '@application/use-cases/messaging/SetConversationStatus';
import type { ListTasks } from '@application/use-cases/ListTasks';
import type { RefreshClientBalanceIfStale } from '@application/use-cases/RefreshClientBalanceIfStale';
import { ReplyWithAssistant } from '@application/use-cases/assistant/ReplyWithAssistant';
import { ResolveAssistantFacts } from '@application/use-cases/assistant/ResolveAssistantFacts';
import {
  PrismaAssistantIntentRepository,
  PrismaAssistantProfileRepository,
} from '@infrastructure/adapters/prisma/PrismaAssistantProfileRepository';
import { PrismaAssistantCatalogRepository } from '@infrastructure/adapters/prisma/PrismaAssistantCatalogRepository';
import { PrismaAssistantRunRepository } from '@infrastructure/adapters/prisma/PrismaAssistantRunRepository';
import { PrismaAssistantRoutingConfigRepository } from '@infrastructure/adapters/prisma/PrismaAssistantRoutingConfigRepository';
import { PrismaFeatureFlagRepository } from '@infrastructure/adapters/prisma/PrismaFeatureFlagRepository';
import { AssistantDataSourceRegistryImpl } from '@infrastructure/adapters/assistant/AssistantDataSourceRegistryImpl';
import { ClienteSaldoResolver } from '@infrastructure/adapters/assistant/ClienteSaldoResolver';
import { ClienteServicioResolver } from '@infrastructure/adapters/assistant/ClienteServicioResolver';
import { OsAbiertasResolver } from '@infrastructure/adapters/assistant/OsAbiertasResolver';
import { ChatwootAssistantConversationGateway } from '@infrastructure/adapters/assistant/ChatwootAssistantConversationGateway';
import { HttpDeepSeekAssistant } from '@infrastructure/adapters/deepseek/HttpDeepSeekAssistant';

export interface ComposeAssistantEngineDeps {
  conversationRepo: ConversationRepository;
  customerRepo: CustomerRepository;
  chatwootGateway: ChatwootGateway;
  sendMessage: SendMessage;
  setConversationArea: SetConversationArea;
  setConversationStatus: SetConversationStatus;
  listTasks: ListTasks;
  threadReader: AssistantThreadReader;
  clientResolver: AssistantClientResolver;
  refreshBalance?: RefreshClientBalanceIfStale;
}

/**
 * ai-assistant-multiagent (T6.3) — wiring del MOTOR, separado del de la configuración.
 *
 * La separación es deliberada: `composeAssistantModule` cablea las rutas de configuración (que
 * pueden estar vivas y usándose) mientras el motor sigue apagado por el flag
 * `ai-assistant-enabled`. Podés cargar agentes y escribir intenciones con el bot mudo.
 *
 * ⚠️ **El bug W6 del EPIC #38 nació de exactamente esto**: las rutas quedaron cableadas pero el
 * hook nunca se inyectó en `app.ts` — CI verde, feature muerta en prod. Por eso este módulo se
 * verifica a mano contra el design Y se pinea con un composition-root test.
 *
 * `noc.cortes` NO se registra: no existe un mapeo confiable cliente→zona→alerta, y un resolver
 * que adivinara respondería "no hay cortes" sin respaldo (design D2). El catálogo lo tiene
 * deshabilitado y `ResolveAssistantFacts` omite las keys sin resolver — las dos capas coinciden.
 */
export function composeAssistantEngine(deps: ComposeAssistantEngineDeps): ReplyWithAssistant {
  const catalogRepo = new PrismaAssistantCatalogRepository();

  const registry = new AssistantDataSourceRegistryImpl([
    new ClienteSaldoResolver(deps.customerRepo, deps.refreshBalance),
    new ClienteServicioResolver(deps.customerRepo),
    new OsAbiertasResolver(deps.listTasks),
  ]);

  return new ReplyWithAssistant(
    new PrismaFeatureFlagRepository(),
    new PrismaAssistantRoutingConfigRepository(),
    new PrismaAssistantProfileRepository(),
    new PrismaAssistantIntentRepository(),
    deps.threadReader,
    deps.clientResolver,
    new ResolveAssistantFacts(catalogRepo, registry),
    new HttpDeepSeekAssistant({
      baseUrl: config.assistant.baseUrl,
      apiKey: config.assistant.apiKey,
      timeoutMs: config.assistant.timeoutMs,
    }),
    new ChatwootAssistantConversationGateway(
      deps.conversationRepo,
      deps.sendMessage,
      deps.setConversationArea,
      deps.setConversationStatus,
      deps.chatwootGateway,
    ),
    new PrismaAssistantRunRepository(),
  );
}
