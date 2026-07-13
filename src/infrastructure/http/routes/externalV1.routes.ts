import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
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

export function createExternalV1Router(
  listClients: ListClients,
  getClientDetail: GetClientDetail,
  listContracts?: ListContracts,
  ticketDeps?: ExternalV1TicketDeps,
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

  return router;
}
