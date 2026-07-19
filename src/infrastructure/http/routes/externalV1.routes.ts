import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import multer from 'multer';
import { Customer } from '@domain/entities/customer';
import { ClientNotFoundError } from '@domain/errors';
import { ListClients } from '@application/use-cases/ListClients';
import { GetClientDetail } from '@application/use-cases/GetClientDetail';
import { ListContracts } from '@application/use-cases/ListContracts';
import { ContractSummaryDto } from '@application/dto/contract.dto';
import { deriveTechnology } from '@application/use-cases/deriveTechnology';
import { mapContractStatus } from '@application/use-cases/mapContractStatus';
import { Ticket, TicketPriority } from '@domain/entities/ticket';
import { CreateTicket } from '@application/use-cases/CreateTicket';
import { ReferenceNotFoundError, ContractCustomerMismatchError } from '@domain/errors/scheduling';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { TicketAreaCatalogRepository } from '@domain/ports/TicketAreaCatalogRepository';
import { API_USER_LOGIN } from '@infrastructure/bootstrap/bootstrapApiUser';
import {
  CreateExternalNews,
  CreateExternalNewsResult,
  ExternalNewsWhatsappResult,
} from '@application/use-cases/CreateExternalNews';
import { NewsCategoryNotFoundError } from '@domain/errors/news';
import {
  InvalidLinkAttachmentError,
  TooManyNewsAttachmentsError,
  UnsupportedNewsAttachmentTypeError,
} from '@domain/errors/newsAttachment';
import { NewsPostAttachmentDto } from '@application/dto/newsAttachment.dto';

/**
 * Curated external DTO — only safe, non-sensitive fields.
 * EXCLUDES: grClienteId, login, customAttributes, balanceDue, balanceCurrency,
 *           lastBalanceAt, balanceStale (internal/billing data, not for external consumers).
 */
export interface ExternalClientDto {
  id: string;
  name: string;
  email: string;
  phone: string;
  status: string;
  address: string;
  city: string;
  country: string;
  createdAt: string;
}

export function toExternalClientDto(c: Customer): ExternalClientDto {
  return {
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    status: c.status,
    address: c.address,
    city: c.city,
    country: c.country,
    createdAt: c.createdAt,
  };
}

/**
 * Curated external DTO for contracts — only safe, non-sensitive fields.
 * EXCLUDES: type, ip, endDate, name, vendedor, services, clientName.
 * technology is the EFFECTIVE value: manual if set, else derived from plan speed.
 */
export interface ExternalContractDto {
  id: string;
  code: string | null;
  clientId: string;
  plan: string;
  status: string;
  technology: string | null;
  startDate: string;
}

/**
 * Project a ContractSummaryDto into ExternalContractDto.
 * Explicit allow-list — future fields on the source type are NOT automatically
 * included (future-field-safe).
 * technology = deriveTechnology(stored, plan) — manual wins, else derived from speed.
 *
 * NOTE: geo/dirección NO se exponen acá todavía (ListContracts no los trae). Para sumarlos:
 * extender ContractSummaryDto + el query de ListContracts, o un puerto enriquecido.
 */
export function toExternalContractDto(c: ContractSummaryDto): ExternalContractDto {
  return {
    id: c.id,
    code: c.code,
    clientId: c.clientId,
    plan: c.plan,
    // Defense-in-depth at the external seam: map raw GR estado → canonical enum.
    // Idempotent — a value already canonicalized by ListContracts passes through.
    status: mapContractStatus(c.status),
    technology: deriveTechnology(c.technology, c.plan),
    startDate: c.startDate,
  };
}

/** Fixed ticket priority enum (TicketPriority) — external callers must send one of these. */
const EXTERNAL_TICKET_PRIORITIES: readonly TicketPriority[] = ['low', 'medium', 'high'];

// Length caps for the external write surface. Unbounded text is a storage-abuse
// vector on a PUBLIC write endpoint (a key holder could POST ~100kb of text per
// request, sustained). express.json's 100kb ceiling is the only other bound.
const MAX_SUBJECT_LEN = 200;
const MAX_DESCRIPTION_LEN = 5000;

/**
 * Curated external DTO for a created ticket — allow-list, safe fields only.
 * EXCLUDES internal / PII fields: reporterId/reporterName (always the system api
 * user), assigneeId/assigneeName, areaId/areaColor (areaName is exposed instead),
 * grCasoId, customerName, resolvedAt/archivedAt/updatedAt, tasks.
 * Future fields on the Ticket entity are NOT auto-included (future-field-safe).
 */
export interface ExternalTicketDto {
  id: string;
  sequenceNumber: number;
  subject: string;
  description: string;
  status: string;
  priority: string;
  customerId: string | null;
  contractId: string | null;
  areaName: string | null;
  createdAt: string;
}

export function toExternalTicketDto(t: Ticket): ExternalTicketDto {
  return {
    id: t.id,
    sequenceNumber: t.sequenceNumber,
    subject: t.subject,
    description: t.description,
    status: t.status,
    priority: t.priority,
    customerId: t.customerId,
    contractId: t.contractId,
    areaName: t.areaName,
    createdAt: t.createdAt,
  };
}

// Length caps for the external NEWS write surface — same rationale as the ticket
// caps above (bound a PUBLIC write endpoint against storage abuse). Mirror the
// internal CreateNewsPostSchema bounds (title 1..200, body 1..20000 markdown).
const MAX_NEWS_TITLE_LEN = 200;
const MAX_NEWS_BODY_LEN = 20000;
// L2 — per-link caps (symmetric with title/body). A key holder could otherwise inject
// unbounded text via link.url / link.title. 2048 is the de-facto safe URL length.
const MAX_LINK_URL_LEN = 2048;
const MAX_LINK_TITLE_LEN = 200;

// Multipart limits for POST /news binary uploads. This is a PUBLIC (api-key) write, so
// the ceilings are TIGHTER than the internal newsMedia.routes: 10 MiB/file, at most 10
// files under `files`, AND a 40 MiB TOTAL-batch cap (below). Note: the per-post COMBINED
// cupo (links + files ≤ 20) still lives in the use case — this only bounds FILES/request.
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 10;
const FILES_FIELD = 'files';

/**
 * fix-be #1 [ALTO] — sin este cap, `MAX_FILE_BYTES × MAX_FILES` (10MB × 10) deja pasar
 * hasta 100 MB en RAM por request (multer memoryStorage) sobre una superficie PÚBLICA:
 * un DoS de memoria trivial. Este techo del TOTAL del lote (40 MB) corta ANTES de llegar
 * al handler. Mismo patrón que `MAX_TOTAL_BATCH_BYTES` en messaging.routes.ts.
 */
const MAX_TOTAL_BATCH_BYTES = 40 * 1024 * 1024;

/**
 * Unified boolean parser for POST /news (works for JSON and multipart WITHOUT branching
 * on content-type): a real boolean (JSON) OR the strings "true"/"false" (multipart
 * form-fields arrive as strings). Returns the boolean, `undefined` if absent, or the
 * sentinel `'INVALID'` if present but not coercible (→ 400).
 */
function parseUnifiedBoolean(raw: unknown): boolean | undefined | 'INVALID' {
  if (raw === undefined) return undefined;
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return 'INVALID';
}

/**
 * Unified links parser for POST /news: an array (JSON) OR a JSON STRING that parses to
 * an array (multipart). Returns the array, `undefined` if absent, or `null` if present
 * but not an array / not a JSON-string-of-array (→ 400). Per-item shape is validated by
 * the caller (url string ≤ 2048, title string ≤ 200) — unchanged from the JSON contract.
 */
function parseUnifiedLinks(raw: unknown): unknown[] | undefined | null {
  if (raw === undefined) return undefined;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Curated external view of a news attachment (L4). The internal NewsPostAttachmentDto
 * carries `uploadedById` (= the system "api" user id) and `newsPostId` (redundant with
 * the post id) — neither belongs on a PUBLIC response. Explicit allow-list.
 */
export interface ExternalNewsAttachmentDto {
  id: string;
  kind: 'image' | 'file' | 'link';
  filename: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  url: string | null;
  fileUrl: string | null;
  createdAt: string;
}

function toExternalNewsAttachmentDto(a: NewsPostAttachmentDto): ExternalNewsAttachmentDto {
  return {
    id: a.id,
    kind: a.kind,
    filename: a.filename,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    url: a.url,
    fileUrl: a.fileUrl,
    createdAt: a.createdAt,
  };
}

/**
 * Curated external DTO for a created news post — allow-list, safe fields only.
 * EXCLUDES internal fields: authorId/authorName (always the system api user), body
 * (echoing ~20kb of markdown back is pointless), categoryId/lastBroadcastAt/read/
 * archivedAt/updatedAt. `category` is the NAME (not the id). `attachments` are the
 * REDUCED external view (no uploadedById/newsPostId). Future fields on the source
 * result are NOT auto-included (future-field-safe).
 */
export interface ExternalNewsDto {
  id: string;
  title: string;
  /** Category NAME (not id). */
  category: string;
  pinned: boolean;
  publishedAt: string;
  attachments: ExternalNewsAttachmentDto[];
  whatsapp: ExternalNewsWhatsappResult;
}

export function toExternalNewsDto(r: CreateExternalNewsResult): ExternalNewsDto {
  return {
    id: r.post.id,
    title: r.post.title,
    category: r.post.category.name,
    pinned: r.post.pinned,
    publishedAt: r.post.publishedAt,
    attachments: r.attachments.map(toExternalNewsAttachmentDto),
    whatsapp: r.whatsapp,
  };
}

/**
 * Dependencies for the external WRITE surface. OPTIONAL on the router: POST
 * /tickets is mounted only when present. Grouped so app.ts wires them explicitly
 * and a composition-root test can pin that wiring (anti-W6 "feature muerta").
 */
export interface ExternalV1TicketDeps {
  createTicket: CreateTicket;
  rbacUserRepo: RbacUserRepository;
  ticketAreaRepo: TicketAreaCatalogRepository;
  /** Rate limiter applied ONLY to POST /tickets (external write surface). Optional
   *  so in-memory tests can mount the route without a limiter. */
  rateLimiter?: RequestHandler;
}

/**
 * Dependencies for the external NEWS write surface (external-news). OPTIONAL on the
 * router: POST /news is mounted only when present. Same mould as ExternalV1TicketDeps
 * so app.ts wires it explicitly and a composition-root test can pin the wiring.
 */
export interface ExternalV1NewsDeps {
  createExternalNews: CreateExternalNews;
  /** Resolves the system "api" author by login (→ 503 if not provisioned). */
  rbacUserRepo: RbacUserRepository;
  /** Rate limiter applied ONLY to POST /news. Optional for in-memory tests. */
  rateLimiter?: RequestHandler;
}

export function createExternalV1Router(
  listClients: ListClients,
  getClientDetail: GetClientDetail,
  listContracts?: ListContracts,
  ticketDeps?: ExternalV1TicketDeps,
  newsDeps?: ExternalV1NewsDeps,
): Router {
  const router = Router();

  /**
   * GET /clients
   * Query: page (number, default 1), limit (number, default 25, max 100),
   *        search (string), status (string — exact ClientStatus).
   */
  router.get('/clients', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rawPage  = parseInt(req.query['page']  as string, 10);
      const rawLimit = parseInt(req.query['limit'] as string, 10);

      const page  = Number.isFinite(rawPage)  && rawPage  > 0  ? rawPage  : 1;
      const limit = Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, 100)
        : 25;

      const search = typeof req.query['search'] === 'string' ? req.query['search'] : undefined;
      const status = typeof req.query['status'] === 'string' ? req.query['status'] : undefined;

      const result = await listClients.execute({ page, limit, search, status });

      res.json({
        data:       result.data.map(toExternalClientDto),
        total:      result.total,
        page:       result.page,
        limit:      result.limit,
        totalPages: Math.ceil(result.total / result.limit),
      });
    } catch (err) {
      next(err);
    }
  });

  /**
   * GET /clients/:id
   * Returns the client as ExternalClientDto; 404 if not found.
   */
  router.get('/clients/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const customer = await getClientDetail.execute(req.params['id'] as string);
      res.json(toExternalClientDto(customer));
    } catch (err) {
      if (err instanceof ClientNotFoundError) {
        res.status(404).json({ error: err.message, code: err.code });
        return;
      }
      next(err);
    }
  });

  /**
   * GET /contracts
   * Query: page (number, default 1), limit (number, default 25, max 100),
   *        search (string), status (string), technology (string — exact catalog value).
   *
   * Note: technology filter matches against the STORED value, not the derived one.
   * A backfill of the stored field (follow-up task) is needed for derived-value filtering.
   */
  if (listContracts) {
    router.get('/contracts', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const rawPage  = parseInt(req.query['page']  as string, 10);
        const rawLimit = parseInt(req.query['limit'] as string, 10);

        const page  = Number.isFinite(rawPage)  && rawPage  > 0  ? rawPage  : 1;
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(rawLimit, 100)
          : 25;

        const search     = typeof req.query['search']     === 'string' ? req.query['search']     : undefined;
        const status     = typeof req.query['status']     === 'string' ? req.query['status']     : undefined;
        const technology = typeof req.query['technology'] === 'string' ? req.query['technology'] : undefined;

        const result = await listContracts.execute({ page, limit, search, status, technology });

        res.json({
          data:       result.data.map(toExternalContractDto),
          total:      result.total,
          page:       result.page,
          limit:      result.pageSize ?? limit,
          totalPages: result.totalPages,
        });
      } catch (err) {
        next(err);
      }
    });
  }

  // ── POST /tickets — first WRITE on the external API (external-create-ticket) ──
  // Machine-to-machine: no session, so the ticket is authored by the system "Api"
  // user (resolved by login). Reuses CreateTicket (FK customer+contract + ownership
  // → 422). `area` arrives by NAME (resolved against the catalog → 422 if unknown);
  // `priority` is the fixed low|medium|high enum (→ 400 if invalid). Response is
  // the curated ExternalTicketDto. Mounted only when ticketDeps is wired.
  if (ticketDeps) {
    const { createTicket, rbacUserRepo, ticketAreaRepo, rateLimiter } = ticketDeps;
    const writeGuards: RequestHandler[] = rateLimiter ? [rateLimiter] : [];
    router.post('/tickets', ...writeGuards, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const subject = typeof body['subject'] === 'string' ? body['subject'].trim() : '';
        const description = typeof body['description'] === 'string' ? body['description'].trim() : '';
        const customerId = typeof body['customerId'] === 'string' ? body['customerId'] : '';
        const contractId = typeof body['contractId'] === 'string' ? body['contractId'] : '';
        const area = typeof body['area'] === 'string' ? body['area'].trim() : '';
        const priority = typeof body['priority'] === 'string' ? body['priority'] : '';

        // Required-field validation (400) — every field is mandatory on this surface.
        const missing: string[] = [];
        if (!subject) missing.push('subject');
        if (!description) missing.push('description');
        if (!customerId) missing.push('customerId');
        if (!contractId) missing.push('contractId');
        if (!area) missing.push('area');
        if (!priority) missing.push('priority');
        if (missing.length > 0) {
          res.status(400).json({
            error: `Missing or invalid required fields: ${missing.join(', ')}`,
            code: 'VALIDATION_ERROR',
          });
          return;
        }

        // Length caps (400) — bound the public write surface against storage abuse.
        if (subject.length > MAX_SUBJECT_LEN || description.length > MAX_DESCRIPTION_LEN) {
          res.status(400).json({
            error: `Field too long: subject <= ${MAX_SUBJECT_LEN}, description <= ${MAX_DESCRIPTION_LEN} chars`,
            code: 'VALIDATION_ERROR',
          });
          return;
        }

        // Priority must be one of the fixed enum values (400 — bad format, no default).
        if (!EXTERNAL_TICKET_PRIORITIES.includes(priority as TicketPriority)) {
          res.status(400).json({
            error: `Invalid priority "${priority}" (allowed: ${EXTERNAL_TICKET_PRIORITIES.join(', ')})`,
            code: 'VALIDATION_ERROR',
          });
          return;
        }

        // Resolve the area by NAME against the catalog (422 if unknown).
        const areaEntry = await ticketAreaRepo.getByName(area);
        if (!areaEntry) {
          res.status(422).json({ error: `Area "${area}" not found`, code: 'TICKET_AREA_NOT_FOUND' });
          return;
        }

        // Resolve the system "Api" reporter — bootstrapped UNCONDITIONALLY in main
        // (bootstrapSystemUsers). If absent, the platform is misconfigured → 503.
        const reporter = await rbacUserRepo.findByLogin(API_USER_LOGIN);
        if (!reporter) {
          res.status(503).json({
            error: 'System reporter not provisioned',
            code: 'REPORTER_UNAVAILABLE',
          });
          return;
        }

        // CreateTicket enforces customer + contract FK existence + ownership.
        const ticket = await createTicket.execute({
          subject,
          description,
          customerId,
          contractId,
          priority: priority as TicketPriority,
          reporterId: reporter.id,
          areaId: areaEntry.id,
        });

        res.status(201).json(toExternalTicketDto(ticket));
      } catch (err) {
        // FK existence (customer/contract not found) → 422 with a curated code.
        if (err instanceof ReferenceNotFoundError) {
          const code =
            err.kind === 'customer' ? 'CUSTOMER_NOT_FOUND'
              : err.kind === 'contract' ? 'CONTRACT_NOT_FOUND'
                : 'REFERENCE_NOT_FOUND';
          res.status(422).json({ error: err.message, code });
          return;
        }
        // Contract does not belong to the customer → 422.
        if (err instanceof ContractCustomerMismatchError) {
          res.status(422).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
      }
    });
  }

  // ── POST /news — 2nd WRITE on the external API (external-news) ────────────────
  // Machine-to-machine: authored by the system "Api" user (resolved by login). Reuses
  // CreateExternalNews, which resolves the category BY NAME (→ 422 if unknown), validates
  // links up-front (all-or-nothing on the 4xx path), and broadcasts to WhatsApp BEST-EFFORT
  // (known nocBroadcast errors surface as whatsapp.sent=false, they do NOT fail the request).
  // 400 = type/shape validation; 422 = domain (category/link/too-many). Mounted only when
  // newsDeps is wired.
  if (newsDeps) {
    const { createExternalNews, rbacUserRepo, rateLimiter } = newsDeps;
    const writeGuards: RequestHandler[] = rateLimiter ? [rateLimiter] : [];

    // Multer for the OPTIONAL multipart mode — same mould as newsMedia.routes. On a JSON
    // request it is NOT multipart, so multer calls next() WITHOUT touching req.body (already
    // parsed by express.json). Its limit errors are translated to clean 4xx (never 500).
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: MAX_FILE_BYTES, files: MAX_FILES },
    });
    const uploadFiles: RequestHandler = (req, res, next) => {
      upload.array(FILES_FIELD, MAX_FILES)(req, res, (err: unknown) => {
        if (!err) {
          // fix-be #1 [ALTO] — cap del tamaño TOTAL del lote (no solo por archivo).
          const files = (req.files as Express.Multer.File[] | undefined) ?? [];
          const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
          if (totalBytes > MAX_TOTAL_BATCH_BYTES) {
            res.status(413).json({
              error: `The combined size of all files exceeds the ${Math.floor(MAX_TOTAL_BATCH_BYTES / (1024 * 1024))}MB total batch limit`,
              code: 'BATCH_TOO_LARGE',
            });
            return;
          }
          next();
          return;
        }
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: 'One of the files exceeds the 10MB limit', code: 'FILE_TOO_LARGE' });
            return;
          }
          if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
            res.status(400).json({ error: `At most ${MAX_FILES} files are allowed under the "files" field`, code: 'TOO_MANY_FILES' });
            return;
          }
          res.status(400).json({ error: err.message, code: 'UPLOAD_ERROR' });
          return;
        }
        next(err);
      });
    };

    // Multer wrapper sits AFTER the rate limiter, BEFORE the handler.
    router.post('/news', ...writeGuards, uploadFiles, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const title = typeof body['title'] === 'string' ? body['title'].trim() : '';
        const newsBody = typeof body['body'] === 'string' ? body['body'].trim() : '';
        const category = typeof body['category'] === 'string' ? body['category'].trim() : '';

        // Required-field validation (400) — title, body and category are mandatory.
        const missing: string[] = [];
        if (!title) missing.push('title');
        if (!newsBody) missing.push('body');
        if (!category) missing.push('category');
        if (missing.length > 0) {
          res.status(400).json({
            error: `Missing or invalid required fields: ${missing.join(', ')}`,
            code: 'VALIDATION_ERROR',
          });
          return;
        }

        // Length caps (400) — bound the public write surface against storage abuse.
        if (title.length > MAX_NEWS_TITLE_LEN || newsBody.length > MAX_NEWS_BODY_LEN) {
          res.status(400).json({
            error: `Field too long: title <= ${MAX_NEWS_TITLE_LEN}, body <= ${MAX_NEWS_BODY_LEN} chars`,
            code: 'VALIDATION_ERROR',
          });
          return;
        }

        // pinned — optional boolean. Unified: real boolean (JSON) OR "true"/"false"
        // (multipart form-field). Present-but-not-coercible → 400.
        const pinnedParsed = parseUnifiedBoolean(body['pinned']);
        if (pinnedParsed === 'INVALID') {
          res.status(400).json({ error: 'pinned must be a boolean', code: 'VALIDATION_ERROR' });
          return;
        }
        const pinned = pinnedParsed ?? false;

        // sendToWhatsapp — optional boolean (same unified parsing as pinned).
        const sendToWhatsappParsed = parseUnifiedBoolean(body['sendToWhatsapp']);
        if (sendToWhatsappParsed === 'INVALID') {
          res.status(400).json({ error: 'sendToWhatsapp must be a boolean', code: 'VALIDATION_ERROR' });
          return;
        }
        const sendToWhatsapp = sendToWhatsappParsed ?? false;

        // links — optional array of { url: string, title?: string }. Unified: an array
        // (JSON) OR a JSON STRING that parses to an array (multipart). TYPE/shape checks
        // are 400 here; the DOMAIN checks (combined count > 20, non-http(s) scheme) are 422
        // and live in the use case (TooManyNewsAttachments / InvalidLinkAttachment).
        const links: { url: string; title?: string }[] = [];
        const linksParsed = parseUnifiedLinks(body['links']);
        if (linksParsed === null) {
          res.status(400).json({ error: 'links must be an array (or a JSON string of an array)', code: 'VALIDATION_ERROR' });
          return;
        }
        if (linksParsed !== undefined) {
          for (const raw of linksParsed) {
            const item = (raw ?? {}) as Record<string, unknown>;
            if (typeof item['url'] !== 'string') {
              res.status(400).json({ error: 'each link.url must be a string', code: 'VALIDATION_ERROR' });
              return;
            }
            // L2 — cap url length (400) BEFORE the use case validates the http(s) shape.
            if (item['url'].length > MAX_LINK_URL_LEN) {
              res.status(400).json({
                error: `link.url too long (max ${MAX_LINK_URL_LEN} chars)`,
                code: 'VALIDATION_ERROR',
              });
              return;
            }
            if (item['title'] !== undefined && typeof item['title'] !== 'string') {
              res.status(400).json({ error: 'each link.title must be a string', code: 'VALIDATION_ERROR' });
              return;
            }
            if (typeof item['title'] === 'string' && item['title'].length > MAX_LINK_TITLE_LEN) {
              res.status(400).json({
                error: `link.title too long (max ${MAX_LINK_TITLE_LEN} chars)`,
                code: 'VALIDATION_ERROR',
              });
              return;
            }
            const linkTitle = typeof item['title'] === 'string' ? item['title'] : undefined;
            links.push(linkTitle !== undefined ? { url: item['url'], title: linkTitle } : { url: item['url'] });
          }
        }

        // files — binary uploads from multer (multipart mode). Absent/empty in JSON mode.
        // Mapped to the use case's AttachNewsFile shape; type validation lives in the use
        // case (UnsupportedNewsAttachmentTypeError → 415) so a bad file never creates a post.
        const uploaded = (req.files as Express.Multer.File[] | undefined) ?? [];
        const files = uploaded.map((f) => ({
          buffer: f.buffer,
          originalName: f.originalname,
          mimeType: f.mimetype,
        }));

        // Resolve the system "Api" author — bootstrapped UNCONDITIONALLY in main
        // (bootstrapSystemUsers). If absent, the platform is misconfigured → 503.
        const reporter = await rbacUserRepo.findByLogin(API_USER_LOGIN);
        if (!reporter) {
          res.status(503).json({
            error: 'System reporter not provisioned',
            code: 'REPORTER_UNAVAILABLE',
          });
          return;
        }

        const result = await createExternalNews.execute({
          title,
          body: newsBody,
          category,
          pinned,
          links,
          files,
          sendToWhatsapp,
          authorId: reporter.id,
          authorName: reporter.name,
        });

        res.status(201).json(toExternalNewsDto(result));
      } catch (err) {
        // An unsupported binary type is a well-formed request with an unacceptable
        // payload → 415 (mirrors the internal newsMedia route). Its `code` is a wire contract.
        if (err instanceof UnsupportedNewsAttachmentTypeError) {
          res.status(415).json({ error: err.message, code: err.code });
          return;
        }
        // Domain errors from the orchestration → 422 (well-formed request, invalid
        // reference/semantics). Each `code` is a wire contract.
        if (
          err instanceof NewsCategoryNotFoundError ||
          err instanceof InvalidLinkAttachmentError ||
          err instanceof TooManyNewsAttachmentsError
        ) {
          res.status(422).json({ error: err.message, code: err.code });
          return;
        }
        next(err);
      }
    });
  }

  return router;
}
