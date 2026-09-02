/**
 * machineActorMiddleware — external-bulk-messaging fix wave F1 (finding F6,
 * AUDIT-1/AUDIT-2).
 *
 * Adjunta a `req.user` el usuario MAQUINA (`RbacUser` de sistema) que esta
 * detras de una superficie M2M autenticada por API key, para que
 * `auditMutationsMiddleware` (global, `app.ts`) escriba `actorId`/`actorLogin`
 * REALES en vez de `anonymous`.
 *
 * ── Por que esto NO es "un req.user sintetico que miente" ────────────────────
 * El design (D7.b) rechazaba inyectar un `req.user` falso, y con razon: poner
 * un usuario inventado donde no hay nadie corrompe TODA la tabla de auditoria.
 * Pero aca no hay nada inventado: `api-messaging` es un `RbacUser` REAL,
 * persistido, con FK — el MISMO id que queda en `Campaign.createdById` de cada
 * campana que este router crea (D2). El actor de la mutacion es exactamente
 * ese. Lo que mentia era el `anonymous`.
 *
 * Alcance: se monta SOLO en el router de la key dedicada. Nunca corre sobre
 * rutas de sesion, asi que no puede pisar un usuario humano.
 *
 * Fail-soft: si el usuario de sistema no esta bootstrapeado (o el repo falla),
 * NO se voltea el request — se deja `req.user` sin tocar y la auditoria vuelve
 * a `anonymous`. Los use cases ya tienen su propio guard duro
 * (`ReporterUnavailableError`, 503) para ese caso; la auditoria no es el lugar
 * donde enterarse.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';

export function machineActorMiddleware(userRepo: RbacUserRepository, login: string): RequestHandler {
  return function attachMachineActor(req: Request, _res: Response, next: NextFunction): void {
    void userRepo
      .findByLogin(login)
      .then((user) => {
        if (user) {
          req.user = { id: user.id, username: user.login, email: user.email ?? '' };
        }
      })
      .catch((err: unknown) => {
        console.error('[audit] machineActorMiddleware could not resolve the machine actor', err);
      })
      .finally(() => next());
  };
}
