/**
 * suricata-tickets-mirror — hallazgo en vivo (2026-09-13): el hilo de un
 * ticket NO vive en el HTML de Suricata (ver `selectors.ts`), pero
 * `POST https://backend.suricata.chat/metadata-ticket {merchant, ticketId}`
 * devuelve un `conversation_id` de Botpress, y `POST .../metadata-merchant
 * {merchant}` devuelve, sin autenticacion real (solo el slug del merchant),
 * un Personal Access Token de Botpress (`token_pa`) + `bot_id` reales.
 *
 * ⚠️ Esto es casi seguro un bug de autorizacion en la plataforma de Suricata
 * (un endpoint de "metadata" filtrando un PAT de escritura completo sin
 * ningun chequeo mas alla del slug del merchant) -- reportado al usuario,
 * quien autorizo usarlo igual porque es el PAT de SU PROPIO bot, para sus
 * propias conversaciones. Nunca hardcodear el valor del token en el codigo:
 * se pide en runtime en cada sync, nunca se persiste.
 *
 * Con `token_pa`/`bot_id` la API REAL de Botpress
 * (`GET https://api.botpress.cloud/v1/chat/messages?conversationId=...`)
 * devuelve el historial real: texto, direccion (incoming=cliente,
 * outgoing=agente/bot) y adjuntos. Confirmado en vivo devuelve mas reciente
 * primero, sin necesitar paginacion para una ventana chica.
 *
 * Alcance deliberado de esta primera version: solo TEXTO. Las URLs de
 * adjuntos (imagen/audio) apuntan a un host de terceros
 * (`*.digitaloceanspaces.com`) fuera del origin de Suricata -- el guard SSRF
 * de `fetchAttachment` (`assertSameOriginAttachment`) las rechaza a proposito
 * (`invalid_origin`), y ampliar esa allowlist es una decision de seguridad
 * aparte, no algo para colar en este fix.
 */
import type { SuricataScrapedMessage } from '@domain/ports/SuricataScraperPort';
import type { SuricataMessageAuthorKind } from '@domain/entities/suricata';
import type { SuricataBrowserSession } from './PlaywrightSuricataScraper';

const SURICATA_CHAT_BACKEND = 'https://backend.suricata.chat';
const BOTPRESS_API = 'https://api.botpress.cloud';

/** Cuantos mensajes mas recientes se mirroreean por ticket -- "las ultimas, no todo el historial" (pedido del usuario). */
export const LAST_MESSAGES_LIMIT = 10;

interface SuricataMerchantMetadata {
  settingsAll?: Array<{ token_pa?: string; bot_id?: string }>;
}

interface SuricataTicketMetadata {
  conversation_id?: string | null;
}

interface BotpressMessagePayload {
  text?: string;
  imageUrl?: string;
  audioUrl?: string;
  videoUrl?: string;
  fileUrl?: string;
}

interface BotpressMessage {
  id: string;
  createdAt: string;
  payload: BotpressMessagePayload;
  direction: 'incoming' | 'outgoing';
}

interface BotpressMessagesResponse {
  messages?: BotpressMessage[];
}

/** `{tokenPa, botId}` resuelto desde `metadata-merchant` -- ver `fetchSuricataBotpressMerchantConfig`. */
export interface SuricataBotpressMerchantConfig {
  tokenPa: string;
  botId: string;
}

/**
 * suricata-bot-autonomous-actions (Phase G, task G.1, design D3.b) -- factoreado
 * fuera de `fetchLastBotpressMessages` para que `BotpressReplyAdapter` (envio,
 * infra) reuse EXACTAMENTE este mismo lookup en vez de duplicar el fetch a
 * `metadata-merchant` una segunda vez. `null` cuando el merchant no tiene
 * Botpress configurado -- nunca throwea, mismo criterio que el resto de este
 * archivo.
 */
export async function fetchSuricataBotpressMerchantConfig(
  session: SuricataBrowserSession,
  merchant: string,
): Promise<SuricataBotpressMerchantConfig | null> {
  const merchantMeta = await session.fetchJson<SuricataMerchantMetadata>(
    `${SURICATA_CHAT_BACKEND}/metadata-merchant`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { merchant } },
  );
  const botConfig = merchantMeta.settingsAll?.[0];
  const tokenPa = botConfig?.token_pa;
  const botId = botConfig?.bot_id;
  if (!tokenPa || !botId) return null; // Botpress no configurado para este merchant
  return { tokenPa, botId };
}

/**
 * suricata-bot-autonomous-actions (Phase G, task G.3, design D4.a) -- factoreado
 * fuera de `fetchLastBotpressMessages` para que `SendAutonomousSuricataReply`
 * (via `BotpressReplyPort.getConversationId`) reuse EXACTAMENTE este mismo
 * lookup en vez de duplicar el fetch a `metadata-ticket` una segunda vez.
 * `null` cuando el ticket no tiene conversacion de Botpress asociada -- nunca
 * throwea, mismo criterio que el resto de este archivo.
 */
export async function fetchSuricataTicketConversationId(
  session: SuricataBrowserSession,
  merchant: string,
  ticketExternalId: string,
): Promise<string | null> {
  const ticketMeta = await session.fetchJson<SuricataTicketMetadata>(`${SURICATA_CHAT_BACKEND}/metadata-ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { merchant, ticketId: ticketExternalId },
  });
  return ticketMeta.conversation_id ?? null;
}

/**
 * Nunca throwea: un fallo en Botpress (config faltante, ticket sin
 * conversacion, API caida) degrada a `[]` -- el mirror de METADATA del
 * ticket (subject/status/prioridad/cliente) no depende de esto y no se
 * bloquea por un problema de mensajes.
 */
export async function fetchLastBotpressMessages(
  session: SuricataBrowserSession,
  merchant: string,
  ticketExternalId: string,
  limit: number = LAST_MESSAGES_LIMIT,
): Promise<SuricataScrapedMessage[]> {
  try {
    const merchantConfig = await fetchSuricataBotpressMerchantConfig(session, merchant);
    if (!merchantConfig) return []; // Botpress no configurado para este merchant
    const { tokenPa, botId } = merchantConfig;

    const conversationId = await fetchSuricataTicketConversationId(session, merchant, ticketExternalId);
    if (!conversationId) return []; // ticket sin conversacion de Botpress asociada

    const result = await session.fetchJson<BotpressMessagesResponse>(
      `${BOTPRESS_API}/v1/chat/messages?conversationId=${encodeURIComponent(conversationId)}`,
      { headers: { Authorization: `Bearer ${tokenPa}`, 'x-bot-id': botId } },
    );

    return (result.messages ?? [])
      .slice(0, limit) // Botpress devuelve mas reciente primero
      .reverse() // orden cronologico para guardar/mostrar
      .map((m) => ({
        externalId: m.id,
        author: m.direction === 'incoming' ? 'Cliente' : 'Agente',
        authorKind: (m.direction === 'incoming' ? 'customer' : 'agent') as SuricataMessageAuthorKind,
        body: m.payload.text ?? '',
        sentAt: m.createdAt,
        attachments: [], // ver disclaimer de alcance arriba
      }));
  } catch (err) {
    console.warn(`[suricata-sync] fetchLastBotpressMessages(${ticketExternalId}) failed:`, (err as Error).message);
    return [];
  }
}
