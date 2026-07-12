/**
 * registerChatwootWebhook.ts — one-shot, IDEMPOTENT registration of the Prominense
 * messaging webhook against Chatwoot (messaging-inbox F1, design.md §3/§9, task 7.2).
 *
 * Registers `POST /api/v1/accounts/:account_id/webhooks` with:
 *   { url: <prominenseWebhookUrl>, subscriptions: [...], secret: CHATWOOT_WEBHOOK_SECRET }
 *
 * IDEMPOTENT: the Chatwoot `webhooks` table has a unique (account_id, url) constraint.
 * Before creating, this script lists the account's existing webhooks and skips creation
 * if one already matches the target url — safe to re-run after a failed/partial setup
 * or when re-verifying the config.
 *
 * NOT wired into app.ts / the DI container — this is a standalone ops script, run
 * manually once per environment (design.md §9, §Archivos nuevos). It talks to Chatwoot
 * directly via axios rather than going through `HttpChatwootGateway` because listing
 * webhooks is not part of the `ChatwootGateway` domain port (no F1 use case needs it —
 * see `domain/ports/ChatwootGateway.ts`, same "no invention beyond spec" call as `searchContact`).
 *
 * Usage (never hardcode the token/secret — always from env):
 *   CHATWOOT_BASE_URL=https://chat.prometheus-alpha.xyz \
 *   CHATWOOT_ACCOUNT_ID=2 \
 *   CHATWOOT_API_TOKEN=*** \
 *   CHATWOOT_WEBHOOK_SECRET=*** \
 *   npx ts-node scripts/registerChatwootWebhook.ts https://<PROMINENSE_BASE>/api/messaging/webhook
 *
 * The webhook url is a required CLI arg (Prominense's own public base URL is
 * deployment-specific — dev/staging/prod all differ — so it is never hardcoded here).
 */
import axios from 'axios';

const SUBSCRIPTIONS = ['message_created', 'conversation_created', 'conversation_status_changed'];

interface ChatwootWebhook {
  id: number;
  url: string;
}

/**
 * Chatwoot list endpoints wrap the array as `{ payload: [...] }` (or occasionally
 * `{ data: { payload: [...] } }`) — same defensive unwrap as `HttpChatwootGateway.extractRows`.
 */
function extractRows(data: unknown): unknown[] {
  const asRecord = data as Record<string, unknown> | null | undefined;
  const nested = asRecord?.data as Record<string, unknown> | undefined;
  if (nested && Array.isArray(nested.payload)) return nested.payload as unknown[];
  if (asRecord && Array.isArray(asRecord.payload)) return asRecord.payload as unknown[];
  return Array.isArray(data) ? (data as unknown[]) : [];
}

async function main(): Promise<void> {
  const webhookUrl = process.argv[2];
  if (!webhookUrl) {
    console.error('Usage: npx ts-node scripts/registerChatwootWebhook.ts <prominense-webhook-url>');
    console.error('  e.g. npx ts-node scripts/registerChatwootWebhook.ts https://api.ipnext.com.ar/api/messaging/webhook');
    process.exitCode = 1;
    return;
  }

  const baseUrl = process.env.CHATWOOT_BASE_URL;
  const accountId = process.env.CHATWOOT_ACCOUNT_ID;
  const apiToken = process.env.CHATWOOT_API_TOKEN;
  const secret = process.env.CHATWOOT_WEBHOOK_SECRET;

  const missing = ['CHATWOOT_BASE_URL', 'CHATWOOT_ACCOUNT_ID', 'CHATWOOT_API_TOKEN', 'CHATWOOT_WEBHOOK_SECRET'].filter(
    (name) => !process.env[name],
  );
  if (missing.length > 0) {
    console.error(`Missing required env vars: ${missing.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const http = axios.create({
    baseURL: baseUrl,
    headers: { api_access_token: apiToken },
  });
  const accountPath = (suffix: string): string => `/api/v1/accounts/${encodeURIComponent(accountId!)}${suffix}`;

  console.log(`Checking existing webhooks for account ${accountId}...`);
  const { data: listData } = await http.get(accountPath('/webhooks'));
  const existing = extractRows(listData) as ChatwootWebhook[];
  const alreadyRegistered = existing.find((w) => w.url === webhookUrl);

  if (alreadyRegistered) {
    console.log(
      `Webhook already registered (id=${alreadyRegistered.id}, url=${webhookUrl}). Skipping — idempotent no-op.`,
    );
    return;
  }

  console.log(`Registering webhook url=${webhookUrl} subscriptions=[${SUBSCRIPTIONS.join(', ')}]...`);
  const { data } = await http.post(accountPath('/webhooks'), {
    url: webhookUrl,
    subscriptions: SUBSCRIPTIONS,
    secret,
  });
  console.log('Webhook registered:', data);
}

main().catch((err) => {
  console.error('registerChatwootWebhook failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
