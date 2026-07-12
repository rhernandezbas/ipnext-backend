/**
 * registerChatwootWebhook.ts — one-shot, IDEMPOTENT registration of the Prominense
 * messaging webhook against Chatwoot (messaging-inbox F1, design.md §3/§9, task 7.2).
 *
 * IMPORTANT — the webhook SECRET is an OUTPUT, not an input. Chatwoot GENERATES the
 * HMAC secret itself when a webhook is created and IGNORES any `secret` sent in the
 * POST body (and PATCH cannot change it — it is immutable). Verified in prod
 * 2026-07-12: sending our own secret left Chatwoot signing with a different one, so
 * every webhook was rejected 401 by the BE. Therefore this script does NOT set the
 * secret — it READS the secret Chatwoot assigned and prints it so the operator can set
 * it on the backend as `CHATWOOT_WEBHOOK_SECRET` (gh secret set) and re-deploy. The BE
 * validates `X-Chatwoot-Signature` with that exact secret; a mismatch = 401 on every event.
 *
 * IDEMPOTENT: the Chatwoot `webhooks` table has a unique (account_id, url) constraint.
 * Re-running detects the existing webhook by url and just re-prints its secret.
 *
 * NOT wired into app.ts / the DI container — standalone ops script, run manually once
 * per environment. Talks to Chatwoot directly via axios (listing webhooks is not a
 * `ChatwootGateway` domain concern — no F1 use case needs it).
 *
 * Usage (token from env; the secret is printed as OUTPUT):
 *   CHATWOOT_BASE_URL=https://chat.prometheus-alpha.xyz \
 *   CHATWOOT_ACCOUNT_ID=2 \
 *   CHATWOOT_API_TOKEN=*** \
 *   npx ts-node scripts/registerChatwootWebhook.ts https://<PROMINENSE_BASE>/api/messaging/webhook
 *
 * The webhook url is a required CLI arg (Prominense's own public base URL is
 * deployment-specific — dev/staging/prod all differ — so it is never hardcoded here).
 */
import axios from 'axios';

const SUBSCRIPTIONS = ['message_created', 'conversation_created', 'conversation_status_changed'];
const REPO = 'rhernandezbas/ipnext-backend';

interface ChatwootWebhook {
  id: number;
  url: string;
  secret?: string;
}

/**
 * The Chatwoot webhooks LIST endpoint wraps the array as `{ payload: { webhooks: [...] } }`.
 * (The earlier `{ payload: [...] }` assumption was wrong and broke idempotency detection.)
 * Handle that shape plus defensive fallbacks.
 */
function extractWebhooks(data: unknown): ChatwootWebhook[] {
  const root = data as Record<string, unknown> | null | undefined;
  const payload = root?.payload as Record<string, unknown> | undefined;
  if (payload && Array.isArray(payload.webhooks)) return payload.webhooks as ChatwootWebhook[];
  if (root && Array.isArray(root.payload)) return root.payload as ChatwootWebhook[];
  const nested = root?.data as Record<string, unknown> | undefined;
  if (nested && Array.isArray(nested.payload)) return nested.payload as ChatwootWebhook[];
  return Array.isArray(data) ? (data as ChatwootWebhook[]) : [];
}

/** The CREATE endpoint returns `{ payload: { webhook: {...} } }`. */
function extractCreatedWebhook(data: unknown): ChatwootWebhook | undefined {
  const root = data as Record<string, unknown> | null | undefined;
  const payload = root?.payload as Record<string, unknown> | undefined;
  return (payload?.webhook as ChatwootWebhook | undefined) ?? (payload as ChatwootWebhook | undefined);
}

function printSecretInstructions(webhook: ChatwootWebhook): void {
  console.log('');
  console.log('================ ACTION REQUIRED ================');
  if (webhook.secret) {
    console.log('Chatwoot assigned this webhook HMAC secret (it generates its own; it does NOT');
    console.log('honour a secret you send, and PATCH cannot change it). Copy it:');
    console.log('');
    console.log(`  ${webhook.secret}`);
    console.log('');
    console.log('Set it on the backend so the BE validates the HMAC with the SAME secret');
    console.log('(otherwise every webhook is rejected 401), then re-deploy the container:');
    console.log('');
    console.log(`  printf %s '${webhook.secret}' | gh secret set CHATWOOT_WEBHOOK_SECRET -R ${REPO}`);
    console.log('  gh run rerun <last-deploy-run-id>   # or push to redeploy so the container picks it up');
  } else {
    console.log('Chatwoot did NOT return the secret in this response. Read it with:');
    console.log(`  GET {CHATWOOT_BASE_URL}/api/v1/accounts/{account}/webhooks  ->  payload.webhooks[].secret`);
    console.log(`then: printf %s '<secret>' | gh secret set CHATWOOT_WEBHOOK_SECRET -R ${REPO}  and re-deploy.`);
  }
  console.log('================================================');
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

  // CHATWOOT_WEBHOOK_SECRET is intentionally NOT required — it is an OUTPUT of this
  // script (Chatwoot generates it), not an input.
  const missing = ['CHATWOOT_BASE_URL', 'CHATWOOT_ACCOUNT_ID', 'CHATWOOT_API_TOKEN'].filter(
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
  const existing = extractWebhooks(listData);
  const alreadyRegistered = existing.find((w) => w.url === webhookUrl);

  if (alreadyRegistered) {
    console.log(`Webhook already registered (id=${alreadyRegistered.id}, url=${webhookUrl}). Idempotent no-op.`);
    printSecretInstructions(alreadyRegistered);
    return;
  }

  console.log(`Registering webhook url=${webhookUrl} subscriptions=[${SUBSCRIPTIONS.join(', ')}]...`);
  // NB: no `secret` in the body — Chatwoot ignores it and generates its own.
  const { data } = await http.post(accountPath('/webhooks'), {
    url: webhookUrl,
    subscriptions: SUBSCRIPTIONS,
  });
  const created = extractCreatedWebhook(data);
  console.log(`Webhook registered (id=${created?.id ?? '?'}).`);
  printSecretInstructions(created ?? { id: -1, url: webhookUrl });
}

main().catch((err) => {
  console.error('registerChatwootWebhook failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
