import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { GetMyPortfolio } from '@application/use-cases/portfolio/GetMyPortfolio';
import { GetPortfolioByVendedor } from '@application/use-cases/portfolio/GetPortfolioByVendedor';
import { GetAllPortfolios } from '@application/use-cases/portfolio/GetAllPortfolios';

/**
 * Per-route permission guards.
 *  - read   → recapture.read   (agente: su propia cartera /mine)
 *  - assign → recapture.assign (ADMIN marker: cross-agent — cualquier agente o todos)
 *
 * SECURITY: las vistas cross-agent (/by-vendedor, /all) van gateadas en `assign`,
 * NO en `manage`. El agente tiene `manage` (gestiona sus leads), así que gatear en
 * manage filtraría la cartera de otros agentes.
 */
export interface PortfolioRoutePerms {
  read: RequestHandler;
  assign: RequestHandler;
}

export function createPortfolioRouter(
  getMyPortfolio: GetMyPortfolio,
  getPortfolioByVendedor: GetPortfolioByVendedor,
  getAllPortfolios: GetAllPortfolios,
  auth: RequestHandler,
  perms: PortfolioRoutePerms,
): Router {
  const router = Router();

  // ─── GET /mine (read) — cartera del agente logueado ─────────────────────────
  router.get(
    '/mine',
    auth,
    perms.read,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const userId = (req as any).user?.id as string;
        res.json(await getMyPortfolio.execute(userId));
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /by-vendedor?vendedor=<nombre> (assign) — cartera de UN agente ──────
  router.get(
    '/by-vendedor',
    auth,
    perms.assign,
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const raw = req.query.vendedor;
        const vendedor = typeof raw === 'string' ? raw.trim() : '';
        if (!vendedor) {
          res.status(400).json({
            error: 'BAD_REQUEST',
            code: 'MISSING_VENDEDOR',
            message: 'Query param "vendedor" is required.',
          });
          return;
        }
        res.json(await getPortfolioByVendedor.execute(vendedor));
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── GET /all (assign) — cartera de TODOS los agentes ───────────────────────
  router.get(
    '/all',
    auth,
    perms.assign,
    async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        res.json(await getAllPortfolios.execute());
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
