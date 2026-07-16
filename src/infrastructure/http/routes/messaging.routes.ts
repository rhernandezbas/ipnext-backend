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
import multer from 'multer';
import {
  ReceiveChatwootWebhook,
  ChatwootWebhookPayload,
} from '@application/use-cases/messaging/ReceiveChatwootWebhook';
import { ListConversations } from '@application/use-cases/messaging/ListConversations';
import { GetConversation } from '@application/use-cases/messaging/GetConversation';
import { ListMessages } from '@application/use-cases/messaging/ListMessages';
import { SendMessage } from '@application/use-cases/messaging/SendMessage';
import { SetConversationStatus } from '@application/use-cases/messaging/SetConversationStatus';
import { GetInboxClientContext } from '@application/use-cases/messaging/GetInboxClientContext';
import { GetChatAttachmentFile } from '@application/use-cases/messaging/GetChatAttachmentFile';
import { AssignConversation } from '@application/use-cases/messaging/AssignConversation';
import { SetConversationArea } from '@application/use-cases/messaging/SetConversationArea';
import { ListAssignableUsers } from '@application/use-cases/messaging/ListAssignableUsers';
import { ListTicketAreas } from '@application/use-cases/ListTicketAreas';
import { ChatAttachmentNotFoundError, ChatAttachmentNotReadyError } from '@domain/errors/chatAttachment';
import type { ConversationListQuery } from '@domain/ports/ConversationRepository';

/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 1 · MEDIA-5) — construye un header
 * `Content-Disposition` seguro (RFC 5987). Clon EXACTO del helper de
 * `taskAttachments.routes.ts` (duplicado deliberado: distinto router, misma regla),
 * salvo por `disposition` (fix-be #3 — ver `INLINE_SAFE_FILE_TYPES` abajo).
 */
function contentDisposition(filename: string, disposition: 'inline' | 'attachment'): string {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * fix-be #3 (MEDIUM) — stored-XSS: a 'file' attachment is an ARBITRARY document a
 * WhatsApp user sent, and its `content_type` is whatever the sender's client
 * claimed — nothing stops a `.html` upload from arriving as `text/html`. Serving
 * it `inline` renders it (and any embedded `<script>`) in the agent's browser the
 * moment they open it. 'image'/'audio'/'video' are the only fileTypes the FE's
 * media viewer actually needs inline; everything else (i.e. 'file') is forced to
 * `attachment` — same criterion as `GetConversation.BINARY_FILE_TYPES` minus 'file'.
 */
const INLINE_SAFE_FILE_TYPES = new Set(['image', 'audio', 'video']);

/**
 * messaging-inbox-v2-media (F1.5 fase A, Tanda 2 · SEND-6/BE3) — flat multer ceiling
 * for the SEND endpoint. `fileSize` is the PER-FILE multer-level ceiling (100MB,
 * matches the highest per-`fileType` ceiling); `SendMessage` (SEND-1 guard 3)
 * re-validates the TIGHTER per-`fileType` limits (5/16/16/100MB) that multer alone
 * cannot express.
 *
 * fix-be #2 [ALTO] — el comentario anterior decía "clon 1:1 de `uploadPhotos` en
 * `taskAttachments.routes.ts`", lo cual es FALSO en los límites: task-photos es
 * 10MB × 15 archivos (150MB teórico por request); este endpoint es 100MB × 10
 * (1GB teórico en RAM por request, memoryStorage — DoS real, no heredado de aquel).
 * Solo el PATRÓN de wrapper (mapeo de errores de multer a 4xx) es análogo.
 * `MAX_TOTAL_BATCH_BYTES` + `createMessagingSendRateLimiter` (abajo/rateLimiters.ts)
 * son el fix: cap combinado del lote + límite de requests por agente.
 */
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FILES = 10;
const ATTACHMENTS_FIELD = 'attachments';

/**
 * fix-be #2 [ALTO] — sin esto, `fileSize × files` (100MB × 10) permite hasta 1GB en
 * RAM por request, sin ningún techo sobre el TOTAL del lote. Este cap corta la
 * propagación aguas abajo (Chatwoot, el mirror) en cuanto multer termina de
 * bufferear; combinado con el rate-limiter de abajo, evita que un mismo agente
 * sostenga el abuso repitiendo lotes grandes.
 */
const MAX_TOTAL_BATCH_BYTES = 100 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
});

/** Wrapper de multer que traduce sus errores de límite a 4xx claros (nunca 500) —
 * mismo patrón de error-mapping que `uploadPhotos` en `taskAttachments.routes.ts`
 * (ver nota fix-be #2 arriba sobre por qué NO es un clon 1:1 de sus límites). */
const uploadAttachments: RequestHandler = (req, res, next) => {
  upload.array(ATTACHMENTS_FIELD, MAX_FILES)(req, res, (err: unknown) => {
    if (!err) {
      // fix-be #2 [ALTO] — cap de tamaño TOTAL del lote (no solo por archivo).
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
      if (totalBytes > MAX_TOTAL_BATCH_BYTES) {
        res.status(413).json({
          error: `The combined size of all attachments exceeds the ${Math.floor(MAX_TOTAL_BATCH_BYTES / (1024 * 1024))}MB total batch limit`,
          code: 'BATCH_TOO_LARGE',
        });
        return;
      }
      next();
      return;
    }
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({ error: 'One of the files exceeds the 100MB limit', code: 'FILE_TOO_LARGE' });
        return;
      }
      if (err.code === 'LIMIT_FILE_COUNT') {
        res
          .status(400)
          .json({ error: `At most ${MAX_FILES} files are allowed under the "attachments" field`, code: 'TOO_MANY_FILES' });
        return;
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        // fix-be #3 [BAJO] — antes caía en la misma rama que LIMIT_FILE_COUNT y
        // devolvía el mensaje engañoso "At most 10 files..." para un problema
        // totalmente distinto (field name inesperado, no exceso de archivos).
        res.status(400).json({
          error: `Unexpected field — attachments must be sent under the "${ATTACHMENTS_FIELD}" field`,
          code: 'UNEXPECTED_FIELD',
        });
        return;
      }
      res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
      return;
    }
    next(err);
  });
};

/** Per-route permission guards (messaging read/send — RBAC-1/2). */
export interface MessagingRoutePerms {
  read: RequestHandler;
  send: RequestHandler;
}

/**
 * fix-be micro (re-review adversarial, Tanda 2) — `sendRateLimiter` existe para
 * mitigar el DoS de MEDIA (uploads grandes, ver nota fix-be #2 arriba), pero estaba
 * montado sobre TODO el endpoint `POST /conversations/:id/messages`, ANTES de
 * ramificar por `files`. Eso también limitaba los envíos de TEXTO-SOLO (F1, ya en
 * prod, SIN límite) — un agente con muchas respuestas rápidas de texto se comía un
 * 429 falso-positivo, una regresión de comportamiento en un camino que nunca tuvo
 * este gate. `req.is('multipart/form-data')` lee el header `Content-Type` — corre
 * ANTES de multer (no depende del body ya parseado), así que es seguro evaluarlo
 * en este punto del pipeline.
 */
function conditionalSendRateLimiter(limiter: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.is('multipart/form-data')) {
      limiter(req, res, next);
      return;
    }
    next();
  };
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

/**
 * F1.5-C2 (asignación) — valida el body de `PATCH /conversations/:id/assignee`
 * y `PATCH /conversations/:id/area`: la clave debe estar PRESENTE en el body
 * (ausente → 400 — evita la ambigüedad entre "no mandaron el campo" y "quieren
 * desasignar explícitamente con null") y su valor debe ser `string` no-vacío o
 * `null` (nunca otro tipo — cierra el mismo gap de tipado que `firstQueryValue`
 * cierra para query params repetidos).
 */
function parseNullableIdField(
  body: Record<string, unknown> | undefined,
  field: string,
): { ok: true; value: string | null } | { ok: false } {
  if (!body || !(field in body)) return { ok: false };
  const raw = body[field];
  if (raw === null) return { ok: true, value: null };
  if (typeof raw === 'string' && raw.length > 0) return { ok: true, value: raw };
  return { ok: false };
}

/**
 * messaging-inbox-notes (F1.5 fase D, NOTE-6) — reads a `private`/`isPrivate` flag off
 * either wire shape this endpoint accepts: a plain JSON body (`{content, private:true}`,
 * a real boolean) or a multipart form field (`form.append('private','true')`, always a
 * STRING once multer/`express.json()` parse it). Anything else (absent, `false`,
 * `'false'`, any other truthy-looking junk) resolves to `false` — same "default false,
 * zero regression" contract as every other optional flag in this router.
 */
function parsePrivateFlag(body: Record<string, unknown> | undefined): boolean {
  const raw = body?.['private'] ?? body?.['isPrivate'];
  return raw === true || raw === 'true';
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
  /**
   * messaging-inbox-productivity (F1.5 fase C, STATUS-1) — resolver/reabrir/marcar
   * pendiente. Gateado por el MISMO permiso que `sendMessage` (`messaging:send`,
   * ver `perms.send` abajo), no un permiso separado.
   */
  setConversationStatus: SetConversationStatus,
  getInboxClientContext: GetInboxClientContext,
  getChatAttachmentFile: GetChatAttachmentFile,
  chatwootSignatureMw: RequestHandler,
  auth: RequestHandler,
  perms: MessagingRoutePerms,
  /**
   * fix-be #2 [ALTO] — rate-limiter dedicado al endpoint de envío con adjuntos
   * (patrón `createLoginRateLimiter`, `infrastructure/http/middleware/rateLimiters.ts`).
   * Inyectado (no construido acá adentro) para poder testear con límites bajos sin
   * tocar los defaults de producción — mismo criterio que `chatwootSignatureMw`.
   */
  sendRateLimiter: RequestHandler,
  /**
   * F1.5-C2 (asignación) — LOCAL-only (Chatwoot nunca se entera): asigna un
   * agente (RbacUser) a la conversación. Gateado por `perms.send` (mismo
   * permiso que status/envío — no hay un permiso separado para asignar).
   */
  assignConversation: AssignConversation,
  /** F1.5-C2 (asignación) — LOCAL-only. Setea/limpia el área (TicketAreaCatalog). */
  setConversationArea: SetConversationArea,
  /** F1.5-C2 (asignación) — pool asignable para el dropdown. Gateado por `perms.read`. */
  listAssignableUsers: ListAssignableUsers,
  /** F1.5-C2 (asignación) — catálogo de áreas, reusa el use case de tickets vía DI. Gateado por `perms.read`. */
  listTicketAreas: ListTicketAreas,
): Router {
  const router = Router();
  const conditionalSendLimiter = conditionalSendRateLimiter(sendRateLimiter);

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

  // ─── GET /conversations (read) — INBOX-1, F1.5-C2 ?assignment= filter ───────
  router.get(
    '/conversations',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const { page, limit } = req.query as Record<string, string | undefined>;
        const assignment = firstQueryValue(req.query['assignment']);
        const campaignId = firstQueryValue(req.query['campaignId']);
        const status = firstQueryValue(req.query['status']);
        const query: ConversationListQuery = {
          page: page ? Number.parseInt(page, 10) : undefined,
          limit: limit ? Number.parseInt(limit, 10) : undefined,
        };
        // messaging-bulk-inbox (F1, etiqueta #1) — filtro por campaña (combinable con assignment).
        if (campaignId) query.campaignId = campaignId;
        // inbox-resolve (LS-2) — whitelist 'open'|'resolved' (mismo criterio que
        // `assignment` con valor no reconocido: se ignora, sin error). La semántica
        // de bucket vive en el repo (ver `ConversationListQuery.status`).
        if (status === 'open' || status === 'resolved') query.status = status;
        // F1.5-C2 — 'mine' resuelve req.user.id (poblado por `auth`, mismo patrón
        // que rbacUser.routes.ts/portfolio.routes.ts); 'unassigned' filtra
        // assigneeId=null; 'all'/ausente no aplica filtro alguno.
        if (assignment === 'mine') {
          query.assigneeId = req.user?.id as string;
        } else if (assignment === 'unassigned') {
          query.unassigned = true;
        }
        const result = await listConversations.execute(query);
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

  // ─── POST /conversations/:id/messages (send) — SEND-1/2/3, extended SEND-6 ──
  // messaging-inbox-v2-media (Tanda 2) — `uploadAttachments` (multer) parses
  // `multipart/form-data` ONLY: a plain `application/json` request (F1 texto-solo)
  // never sees content-type multipart, so multer no-ops and `express.json()`
  // (mounted globally, BEFORE this router) already parsed `req.body` — zero
  // regression on the JSON path (SEND-6 scenario "texto-solo passthrough").
  router.post(
    '/conversations/:id/messages',
    auth,
    perms.send,
    // fix-be #2 [ALTO] — corre DESPUÉS de RBAC (un 403 no debe consumir cupo del
    // limiter) y ANTES de multer (rechaza antes de bufferear si ya excedió el cupo).
    // fix-be micro (re-review adversarial) — gateado a multipart-only (ver
    // `conditionalSendRateLimiter` arriba): texto-solo (JSON) pasa SIN límite, como
    // en F1 (regresión de comportamiento detectada en re-review — el limiter es
    // para el DoS de MEDIA, no para el camino de texto).
    conditionalSendLimiter,
    uploadAttachments,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const rawContent = body?.['content'];
        const content = typeof rawContent === 'string' ? rawContent : '';
        const files = ((req.files as Express.Multer.File[] | undefined) ?? []).map((f) => ({
          buffer: f.buffer,
          filename: f.originalname,
          contentType: f.mimetype,
        }));
        // NOTE-6 — reads `private`/`isPrivate` off either wire shape (JSON boolean or
        // multipart string); defaults to `false` when absent (cero regresión sobre F1).
        const isPrivate = parsePrivateFlag(body);

        // SEND-6 — at least one of {content non-empty, files.length>0}; a caption-less
        // media-only message IS valid (content falls back to '').
        if (content.trim() === '' && files.length === 0) {
          res.status(400).json({ error: 'content or attachments must be provided', code: 'VALIDATION_ERROR' });
          return;
        }

        const result = await sendMessage.execute(req.params['id'] as string, content, files, isPrivate);
        res.status(201).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── POST /conversations/:id/status (send) — F1.5-C STATUS-1, resolver/reabrir ──
  // Gateado por el MISMO permiso que el envío de mensajes (messaging:send, RBAC-2)
  // — no hay un permiso separado para cambiar el estado. `status` inválido/ausente
  // resuelve en 400 VALIDATION_ERROR vía el error tipado que lanza el use case
  // (mismo patrón try/catch → next(err) que el resto de este router, NO el chequeo
  // inline que usa el body de /messages para content vacío).
  router.post(
    '/conversations/:id/status',
    auth,
    perms.send,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const rawStatus = body?.['status'];
        const status = typeof rawStatus === 'string' ? rawStatus : '';
        const result = await setConversationStatus.execute(req.params['id'] as string, status);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── PATCH /conversations/:id/assignee (send) — F1.5-C2, asignación LOCAL ───
  // Gateado por el MISMO permiso que status/envío (messaging:send) — no hay un
  // permiso separado para asignar. NUNCA llama a Chatwoot (AssignConversation
  // solo toca el mirror).
  router.patch(
    '/conversations/:id/assignee',
    auth,
    perms.send,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const parsed = parseNullableIdField(body, 'assigneeId');
        if (!parsed.ok) {
          res.status(400).json({ error: 'assigneeId must be a non-empty string or null', code: 'VALIDATION_ERROR' });
          return;
        }
        const result = await assignConversation.execute(req.params['id'] as string, parsed.value);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── PATCH /conversations/:id/area (send) — F1.5-C2, asignación LOCAL ───────
  router.patch(
    '/conversations/:id/area',
    auth,
    perms.send,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = req.body as Record<string, unknown> | undefined;
        const parsed = parseNullableIdField(body, 'areaId');
        if (!parsed.ok) {
          res.status(400).json({ error: 'areaId must be a non-empty string or null', code: 'VALIDATION_ERROR' });
          return;
        }
        const result = await setConversationArea.execute(req.params['id'] as string, parsed.value);
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /assignable-users (read) — F1.5-C2, dropdown pool ───────────────────
  // Gate `messaging:read` (no admin.manage/tickets.read) — cualquier agente con
  // acceso al inbox puede ver a quién asignarle una conversación.
  router.get(
    '/assignable-users',
    auth,
    perms.read,
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const data = await listAssignableUsers.execute();
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /areas (read) — F1.5-C2, catálogo de áreas para el dropdown ────────
  // Reusa ListTicketAreas/TicketAreaCatalogRepository vía DI — mismo catálogo
  // que /api/tickets/areas, sin duplicar el puerto.
  router.get(
    '/areas',
    auth,
    perms.read,
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const data = await listTicketAreas.execute();
        res.json({ data });
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /attachments/:id/file (read) — messaging-inbox-v2-media, MEDIA-5 ───────
  // Clon 1:1 de GET /api/scheduling/attachments/:id/file. Resuelve SIEMPRE por el
  // `id` propio del attachment (nunca acepta una storageKey/URL cruda como input).
  router.get(
    '/attachments/:id/file',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      const variant = req.query['variant'] === 'thumb' ? 'thumb' : 'original';
      try {
        const file = await getChatAttachmentFile.execute({
          attachmentId: req.params['id'] as string,
          variant,
        });
        const disposition = INLINE_SAFE_FILE_TYPES.has(file.fileType) ? 'inline' : 'attachment';
        res.setHeader('Content-Type', file.mimeType);
        res.setHeader('Content-Disposition', contentDisposition(file.filename, disposition));
        res.send(file.buffer);
      } catch (err) {
        if (err instanceof ChatAttachmentNotFoundError) {
          res.status(404).json({ error: err.message, code: err.code });
          return;
        }
        if (err instanceof ChatAttachmentNotReadyError) {
          res.status(409).json({ error: err.message, code: err.code });
          return;
        }
        // MEDIA-6/ROB-1 — a repo/storage throw resolves with an immediate error
        // status, never hangs the request.
        next(err);
      }
    },
  );

  return router;
}
