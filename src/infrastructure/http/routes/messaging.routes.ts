/**
 * messaging-inbox (F1) — /api/messaging router (design §6). Two very different
 * trust models share this router:
 *   - POST /webhook: Chatwoot M2M ingest, gated ONLY by HMAC (chatwootSignatureMw) —
 *     NO session auth, NO RBAC (RBAC-4). Chatwoot is not a Prominense user.
 *   - Everything else: session auth + per-route RBAC (messaging:read/send, RBAC-1/2).
 * Pattern: factory + perms interface, auth applied PER ROUTE (actions.routes.ts mold).
 * Every async handler wraps in try/catch → next(err) (lección 504, ROB-1) — the
 * errorHandler global maps typed DomainErrors via statusMap (single source of truth).
 */
import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import {
  ReceiveChatwootWebhook,
  ChatwootWebhookPayload,
} from '@application/use-cases/messaging/ReceiveChatwootWebhook';
import { ListConversations } from '@application/use-cases/messaging/ListConversations';
import { GetConversation } from '@application/use-cases/messaging/GetConversation';
import { ListMessages } from '@application/use-cases/messaging/ListMessages';
import { SendMessage } from '@application/use-cases/messaging/SendMessage';
import { GetInboxClientContext } from '@application/use-cases/messaging/GetInboxClientContext';

/** Per-route permission guards (messaging read/send — RBAC-1/2). */
export interface MessagingRoutePerms {
  read: RequestHandler;
  send: RequestHandler;
}

/**
 * H10 — dedup key derived from the SIGNED payload content, NOT the unsigned
 * `X-Chatwoot-Delivery` header. That header travels outside the HMAC (a plain
 * request header, not part of the signed bytes) — a request captured within the
 * ±5min anti-replay window can be resent with the header stripped or altered, and
 * a client-controlled/absent header must never be able to defeat dedup. Deriving
 * the key from fields Chatwoot itself guarantees unique per real event
 * (`message.id` is globally unique across the account; a conversation's `status`
 * transition pins a specific occurrence) closes that gap. Combined with
 * process-then-record (ROB-2 in `ReceiveChatwootWebhook`) so a failed handler
 * doesn't burn the key either.
 *
 * #10 residual — `conversation_status_changed`'s key ALSO needs `signedTimestamp`
 * (the already-HMAC-verified `X-Chatwoot-Timestamp` header) as an occurrence
 * discriminator. Without it, `${conversationId}:${status}` collapses every visit to
 * the SAME status into one key — an oscillation open→resolved→open→resolved sends
 * the 1st and 3rd deliveries with an IDENTICAL key, so the 3rd (a real, distinct
 * transition) gets discarded as "already seen" and the mirror goes stale. An EXACT
 * replay of a captured request carries the SAME signed timestamp (dedup still
 * catches it); a genuinely new transition always arrives with a fresh one (Chatwoot
 * stamps it per delivery), so this stays replay-safe. `message_created`/
 * `conversation_created` are already unique per real event via `payload.id` — left
 * untouched.
 */
/**
 * fix-be #7 — Express types a repeated query key (`?clientId=a&clientId=b`) as
 * `string[]`, not `string`. A bare `as Record<string, string | undefined>` cast
 * doesn't change that at runtime — `clientId` could be an array, silently
 * breaking the `.some(c => c.id === chosenId)` candidate match (array !== string,
 * always false) or the `refresh === 'true'` check. Normalize by taking the FIRST
 * value, same convention as most single-value query params.
 */
function firstQueryValue(v: unknown): string | undefined {
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : undefined;
  return typeof v === 'string' ? v : undefined;
}

function computeDedupKey(payload: ChatwootWebhookPayload, signedTimestamp: string | undefined): string {
  const conversationId = payload.conversation?.id ?? payload.id;
  switch (payload.event) {
    case 'message_created':
      return `message_created:${payload.id}`;
    case 'conversation_status_changed':
      return `conversation_status_changed:${conversationId}:${payload.status}:${signedTimestamp ?? ''}`;
    case 'conversation_created':
      return `conversation_created:${conversationId}`;
    default:
      return `${payload.event}:${conversationId}`;
  }
}

export function createMessagingRouter(
  receiveChatwootWebhook: ReceiveChatwootWebhook,
  listConversations: ListConversations,
  getConversation: GetConversation,
  listMessages: ListMessages,
  sendMessage: SendMessage,
  getInboxClientContext: GetInboxClientContext,
  chatwootSignatureMw: RequestHandler,
  auth: RequestHandler,
  perms: MessagingRoutePerms,
): Router {
  const router = Router();

  // ─── POST /webhook — Chatwoot M2M ingest (HMAC only, RBAC-4) ────────────────
  router.post(
    '/webhook',
    chatwootSignatureMw,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        // H10 — dedup key computed from the SIGNED payload content (never from the
        // unsigned `X-Chatwoot-Delivery` header, which an attacker can strip/alter
        // on replay). Works regardless of whether the header is present at all.
        // #10 residual — `X-Chatwoot-Timestamp` reaches here only after
        // `chatwootSignatureMw` already verified it against the HMAC (it's part of
        // the signed bytes, HOOK-1/HOOK-2), so it's tamper-proof by the time
        // `computeDedupKey` reads it as the status-change occurrence discriminator.
        const payload = req.body as ChatwootWebhookPayload;
        const signedTimestampHeader = req.headers['x-chatwoot-timestamp'];
        const signedTimestamp = typeof signedTimestampHeader === 'string' ? signedTimestampHeader : undefined;
        const deliveryId = computeDedupKey(payload, signedTimestamp);

        await receiveChatwootWebhook.execute(deliveryId, payload);
        res.status(200).json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /conversations (read) — INBOX-1 ────────────────────────────────────
  router.get(
    '/conversations',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { page, limit } = req.query as Record<string, string | undefined>;
        const result = await listConversations.execute({
          page: page ? Number.parseInt(page, 10) : undefined,
          limit: limit ? Number.parseInt(limit, 10) : undefined,
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /conversations/:id (read) — INBOX-2 fetch-on-open ──────────────────
  router.get(
    '/conversations/:id',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const result = await getConversation.execute(req.params['id'] as string);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /conversations/:id/messages (read) — INBOX-3 ───────────────────────
  router.get(
    '/conversations/:id/messages',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const data = await listMessages.execute(req.params['id'] as string);
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /conversations/:id/client-context (read) — RICH-1..6 ───────────────
  // Lazy, on-demand rich aggregate — see GetInboxClientContext. Same messaging:read
  // guard as the rest of the router (RICH-5, no extra billing/tickets permission).
  router.get(
    '/conversations/:id/client-context',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const clientId = firstQueryValue(req.query['clientId']);
        const refresh = firstQueryValue(req.query['refresh']);
        const result = await getInboxClientContext.execute(req.params['id'] as string, {
          clientId,
          refresh: refresh === 'true' || refresh === '1',
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── POST /conversations/:id/messages (send) — SEND-1/2/3 ───────────────────
  router.post(
    '/conversations/:id/messages',
    auth,
    perms.send,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { content } = req.body as Record<string, unknown>;
        if (typeof content !== 'string' || content.trim() === '') {
          res.status(400).json({ error: 'content must be a non-empty string', code: 'VALIDATION_ERROR' });
          return;
        }

        const result = await sendMessage.execute(req.params['id'] as string, content);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
