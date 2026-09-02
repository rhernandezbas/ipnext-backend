/**
 * bootstrapApiMessagingUser — external-bulk-messaging (D2). Idempotent seed of
 * the system "api-messaging" user: `createdById` de las `Campaign` creadas por
 * `SendExternalBulk` (envío masivo WhatsApp vía la API Externa M2M). Distinto
 * del reporter "api" (backlog #15, `bootstrapApiUser`) a propósito — cada
 * dominio machine-created tiene su PROPIO usuario de sistema, para no mezclar
 * el filtro del cupo diario (D3.a, `countAuthorizedRecipientsByCreatorSince`) con tickets/tasks
 * ingested por GR.
 *
 * Molde EXACTO `bootstrapApiUser` — mismo mecanismo (`bootstrapMachineUser`),
 * UNUSABLE passwordHash inyectada, idempotente por `login`.
 */
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { bootstrapMachineUser, BootstrapMachineUserResult } from './bootstrapMachineUser';
// fix wave F1 (F8) — la constante vive en el DOMINIO (`@domain/constants/machineUsers`):
// los use cases de `application/` la necesitan y no pueden importar de infraestructura.
// Se RE-EXPORTA aca para no romper a ningun consumidor existente.
import { API_MESSAGING_USER_LOGIN } from '@domain/constants/machineUsers';

export { API_MESSAGING_USER_LOGIN };
export const API_MESSAGING_USER_NAME = 'Api Messaging';
export const API_MESSAGING_USER_EMAIL = 'api-messaging@sistema.local';

export type BootstrapApiMessagingUserResult = BootstrapMachineUserResult;

export async function bootstrapApiMessagingUser(
  userRepo: RbacUserRepository,
  opts: { passwordHash: string },
): Promise<BootstrapApiMessagingUserResult> {
  return bootstrapMachineUser(userRepo, {
    login: API_MESSAGING_USER_LOGIN,
    name: API_MESSAGING_USER_NAME,
    email: API_MESSAGING_USER_EMAIL,
    passwordHash: opts.passwordHash,
  });
}
