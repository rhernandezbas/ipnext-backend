import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { GetMyPortfolio } from '@application/use-cases/portfolio/GetMyPortfolio';

/** Per-route permission guards (reuses recapture read per the design). */
export interface PortfolioRoutePerms {
  read: RequestHandler;
}

export function createPortfolioRouter(
  getMyPortfolio: GetMyPortfolio,
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

  return router;
}
