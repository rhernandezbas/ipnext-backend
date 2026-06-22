import { Router, Request, Response, NextFunction } from 'express';
import { Customer } from '@domain/entities/customer';
import { ClientNotFoundError } from '@domain/errors';
import { ListClients } from '@application/use-cases/ListClients';
import { GetClientDetail } from '@application/use-cases/GetClientDetail';
import { ListContracts } from '@application/use-cases/ListContracts';
import { ContractSummaryDto } from '@application/dto/contract.dto';
import { deriveTechnology } from '@application/use-cases/deriveTechnology';

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
    status: c.status,
    technology: deriveTechnology(c.technology, c.plan),
    startDate: c.startDate,
  };
}

export function createExternalV1Router(
  listClients: ListClients,
  getClientDetail: GetClientDetail,
  listContracts?: ListContracts,
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

  return router;
}
