import { Router, type RequestHandler } from 'express';
import type { AuthProvider } from '@domain/ports/AuthProvider';
import type { SessionRepository } from '@domain/ports/SessionRepository';
import type { PermissionAction, RbacModuleCode } from '@domain/entities/rbac';

export interface ComposeSuricataModuleDeps {
  authAdapter: AuthProvider;
  sessionRepo: SessionRepository;
  /** El `requirePerm` de app.ts, INYECTADO — no re-derivado acá (un solo rbacUserRepo). */
  requirePerm: (module: RbacModuleCode, action: PermissionAction) => RequestHandler;
}

/**
 * suricata-tickets-mirror (Fase A — BE Slice 0, design.md D8/D14) — wiring del
 * panel INTERNO (sesión + `suricata.read`/`manage`/`reply`), fuera del cuerpo de
 * `app.ts` (mismo criterio que `composeAlertsModule`/`composeAssistantModule`:
 * evitar inflar el God Object de 3326 líneas).
 *
 * ⚠️ Slice 0 (D14 "wiring vacío"): TODAS las rutas devuelven 501. Las Fases
 * C..F reemplazan este cuerpo con `ListSuricataTickets`, `GetSuricataTicketDetail`,
 * `ComputeSuricataKpis`, `SetSuricataAssignee` y `ReplyToSuricataTicket` —
 * la firma de `ComposeSuricataModuleDeps` YA es la del design (D8) para que
 * ese reemplazo no toque la línea de mount en `app.ts`.
 */
export function composeSuricataModule(_deps: ComposeSuricataModuleDeps): Router {
  const router = Router();

  router.use((_req, res) => {
    res.status(501).json({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
  });

  return router;
}
