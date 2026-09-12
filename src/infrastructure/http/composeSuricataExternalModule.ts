import { Router } from 'express';

/**
 * suricata-tickets-mirror (Fase A — BE Slice 0, design.md D8/D14) — wiring del
 * endpoint EXTERNO token-autenticado (`suricata-bot-verdict`, RBAC-EXT-3: NO
 * gatea por sesión RBAC, autentica por key dedicada — `config.suricata.externalApiKey`).
 *
 * ⚠️ Slice 0 (D14 "wiring vacío"): TODAS las rutas devuelven 501 y este módulo
 * NO recibe deps todavía — a propósito. `config.suricata.*` (D11) y el usuario
 * máquina `api-suricata` (`bootstrapMachineUser`) nacen recién en la Fase D
 * (verdict capability), junto con `createApiKeyMiddleware(config.suricata.externalApiKey)`
 * + `machineActorMiddleware(rbacUserRepo, API_SURICATA_USER_LOGIN)` que el
 * mount de `app.ts` va a envolver alrededor de este router (D8). Introducir esa
 * config a medias en esta fase duplicaría el trabajo de la Fase D (task B.3/D.4)
 * sin habilitar nada: el 501 de acá ya dark-launchea las 12 líneas de `app.ts`
 * que este change necesita reclamar temprano (D8 "recomendación de entrega").
 */
export function composeSuricataExternalModule(): Router {
  const router = Router();

  router.use((_req, res) => {
    res.status(501).json({ error: 'Not implemented', code: 'NOT_IMPLEMENTED' });
  });

  return router;
}
