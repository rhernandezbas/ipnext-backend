/**
 * bootstrapMachineUser — generalización de `bootstrapApiUser` (backlog #15,
 * external-bulk-messaging D2). Crea/reusa un `RbacUser` de sistema idempotente
 * por `login`, con una `passwordHash` INUSABLE (inyectada, nunca generada
 * acá) para que el usuario NUNCA pueda loguearse — solo existe para ser
 * referenciado como autor/creador de registros creados por una máquina
 * (tasks GR-ingested, tickets/campañas de la API externa).
 *
 * Pure function — no process.env / no bcrypt inside, composition-root-driven,
 * trivialmente testeable con `InMemoryRbacUserRepository`. `bootstrapApiUser`
 * y `bootstrapApiMessagingUser` son wrappers delgados sobre esto, cada uno
 * fijando su propio `login`/`name`/`email` (backcompat total de sus tests).
 */
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';

export interface BootstrapMachineUserResult {
  outcome: 'created' | 'exists';
  /** Id del system user — usable como reporterId/createdById. */
  id: string;
}

export async function bootstrapMachineUser(
  userRepo: RbacUserRepository,
  opts: { login: string; name: string; email: string; passwordHash: string },
): Promise<BootstrapMachineUserResult> {
  const existing = await userRepo.findByLogin(opts.login);
  if (existing) {
    return { outcome: 'exists', id: existing.id };
  }

  const user = await userRepo.create({
    name: opts.name,
    email: opts.email,
    login: opts.login,
    passwordHash: opts.passwordHash,
    status: 'active',
  });

  return { outcome: 'created', id: user.id };
}
