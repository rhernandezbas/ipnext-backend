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
import type { AssignConversation } from '@application/use-cases/messaging/AssignConversation';
import type { GestionRealPort } from '@domain/ports/GestionRealPort';
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
import { ClienteFacturasResolver } from '@infrastructure/adapters/assistant/ClienteFacturasResolver';
import { ClienteRecibosHoyResolver } from '@infrastructure/adapters/assistant/ClienteRecibosHoyResolver';
import { PrismaAssistantInvoicesReader } from '@infrastructure/adapters/prisma/PrismaAssistantInvoicesReader';
import { ChatwootAssistantConversationGateway } from '@infrastructure/adapters/assistant/ChatwootAssistantConversationGateway';
import { HttpDeepSeekAssistant } from '@infrastructure/adapters/deepseek/HttpDeepSeekAssistant';
import { PrismaAssistantProviderConfigRepository } from '@infrastructure/adapters/prisma/PrismaAssistantProviderConfigRepository';
import { resolveProviderCredentials } from '@domain/ports/AssistantProviderConfigRepository';

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
  /**
   * ai-assistant-cobranzas (6.3 / D9) — puerto de Gestión Real para `cliente.recibos_hoy`.
   *
   * OPCIONAL porque GR es opt-in (`GR_SYNC_ENABLED`): sin él la fuente **no se registra**, y
   * `ResolveAssistantFacts` omite las keys sin resolver. Ese es el lado seguro: una fuente
   * ausente hace que el bot derive, mientras que una fuente registrada contra un puerto roto
   * podría terminar respondiendo "no encontramos tu pago" — el peor modo de falla de R1.
   */
  gestionReal?: GestionRealPort;
  /**
   * ai-assistant-cobranzas (6.3 / D10 / ACT-4) — desasignación en el espejo LOCAL.
   *
   * Sin esto `unassign` desasigna sólo en Chatwoot y el espejo de Prominense sigue mostrando
   * un agente asignado que ya no está: los dos lados tienen que moverse juntos.
   */
  assignConversation?: AssignConversation;
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
  const providerRepo = new PrismaAssistantProviderConfigRepository();

  // ai-assistant-cobranzas (6.1 / DAT-2 / D8) — lector del ESPEJO de facturas. Se instancia
  // acá, como el resto de los adapters Prisma de este módulo: no tiene configuración ni
  // colaboradores, y hacerlo una dep de `app.ts` sólo agregaría un lugar más donde olvidarse.
  const invoicesReader = new PrismaAssistantInvoicesReader();

  const registry = new AssistantDataSourceRegistryImpl([
    new ClienteSaldoResolver(deps.customerRepo, deps.refreshBalance),
    new ClienteServicioResolver(deps.customerRepo),
    new OsAbiertasResolver(deps.listTasks),
    // ⚠️ **LA MISMA instancia de `refreshBalance` que `cliente.saldo`** (D8). Es un
    // single-flight con TTL por carril: dos instancias = dos vuelos a GR dentro de la misma
    // corrida, y un saldo y unas facturas que pueden venir de payloads distintos. Pineado por
    // identidad (`toBe`), no por tipo, en `assistant-composition.test.ts`.
    // fix wave W9 (REN-1) — el alias de pago sale de la config (`ASSISTANT_PAY_ALIAS`). Sin
    // env, el bloque no menciona alias: un alias equivocado manda la plata del cliente a otra
    // cuenta, así que el default seguro es el silencio.
    new ClienteFacturasResolver(deps.customerRepo, invoicesReader, deps.refreshBalance, config.assistant.payAlias),
    // `cliente.recibos_hoy` sólo existe si GR está configurado (ver `deps.gestionReal`).
    ...(deps.gestionReal
      ? [new ClienteRecibosHoyResolver(deps.customerRepo, deps.gestionReal, deps.threadReader)]
      : []),
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
      // Credenciales POR INVOCACIÓN: la DB pisa al env. Rotar la key desde la pantalla toma
      // efecto en el próximo mensaje, no en el próximo deploy.
      resolveCredentials: async () =>
        resolveProviderCredentials(await providerRepo.get(), {
          baseUrl: config.assistant.baseUrl,
          apiKey: config.assistant.apiKey,
        }),
    }),
    new ChatwootAssistantConversationGateway(
      deps.conversationRepo,
      deps.sendMessage,
      deps.setConversationArea,
      deps.setConversationStatus,
      deps.chatwootGateway,
      // D10/ACT-4 — el lado LOCAL del `unassign`. Los dos lados corren aislados entre sí:
      // que falle uno no puede saltear el otro.
      deps.assignConversation,
    ),
    new PrismaAssistantRunRepository(),
    // fix wave W1 (SEC-6) — la ventana de "hay un humano atendiendo", configurable por env.
    { agentActiveWindowMinutes: config.assistant.agentActiveWindowMinutes },
  );
}
