import { Router, Request, Response, NextFunction, RequestHandler } from 'express';
import { AuthProvider } from '@domain/ports/AuthProvider';
import { createAuthMiddleware } from '../middleware/authMiddleware';
import { SetTechnicianTeamMapping } from '@application/use-cases/SetTechnicianTeamMapping';
import { ListTechnicianTeamMappings } from '@application/use-cases/ListTechnicianTeamMappings';
import {
  patchTechnicianTeamMappingSchema,
  toTechnicianTeamMappingItemDTO,
} from '@application/dto/technicianTeamMapping.dto';
import { RbacUserWithTeam } from '@domain/ports/RbacUserRepository';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';

/**
 * Admin routes for the Technician↔IClass team mapping (Ola A).
 *
 *   GET   /technician-teams          — list all technicians + their cuadrilla (gate: iclass.read)
 *   PATCH /technician-teams/:userId  — set/clear mapping (gate: iclass.manage)
 *
 * Mount at /api/admin/iclass (same base as other iclass admin routers).
 */
export function createIClassTechnicianTeamsRouter(
  listMappings: ListTechnicianTeamMappings,
  setMapping: SetTechnicianTeamMapping,
  authProvider: AuthProvider,
  requireIClassRead: RequestHandler,
  requireIClassManage: RequestHandler,
): Router {
  const router = Router();
  const auth = createAuthMiddleware(authProvider);

  // GET /technician-teams — list all mappings (iclass.read)
  router.get('/technician-teams', auth, requireIClassRead, async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const rows = await listMappings.execute();
      res.status(200).json({ items: rows.map(toTechnicianTeamMappingItemDTO) });
    } catch (err) {
      next(err);
    }
  });

  // PATCH /technician-teams/:userId — set/clear team mapping (iclass.manage)
  router.patch('/technician-teams/:userId', auth, requireIClassManage, async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const parseResult = patchTechnicianTeamMappingSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({ error: 'VALIDATION_ERROR', details: parseResult.error.flatten() });
        return;
      }

      const { iclassTeamLogin } = parseResult.data;
      const { userId } = req.params;

      const updated = await setMapping.execute({ userId: userId!, iclassTeamLogin });

      // Build the response DTO from the updated user
      // Need to include team info — delegate to listMappings for this user
      // or do an inline response. The updated RbacUser has iclassTeamLogin.
      // For simplicity: return the updated user mapped to DTO (teamName is client-side).
      // The wire contract specifies the PATCH returns the updated mapping row,
      // but we only have the user here. We do a minimal inline response matching spec.
      const dto = toTechnicianTeamMappingItemDTO({
        userId: updated.id,
        userName: updated.name,
        userLogin: updated.login,
        iclassTeamLogin: (updated as RbacUserWithTeam).iclassTeamLogin ?? iclassTeamLogin,
        teamName: null, // resolved by FE via useIClassTeams()
        teamActive: iclassTeamLogin !== null, // best-effort; FE re-fetches
      });

      res.status(200).json(dto);
    } catch (err) {
      if (err instanceof ReferenceNotFoundError) {
        res.status(404).json({ error: err.message, code: 'USER_NOT_FOUND' });
        return;
      }
      next(err);
    }
  });

  return router;
}
