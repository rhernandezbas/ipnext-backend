/**
 * bootstrapApiSuricataUser — suricata-tickets-mirror (Phase D, design D8/D11).
 * Idempotent seed of the system "api-suricata" user: `submittedBy` literal
 * value on every `SuricataTicketVerdict` (SubmitSuricataVerdict) and the
 * machine actor `machineActorMiddleware` attaches to `req.user` on the
 * external verdict/attachment router (app.ts mount, for
 * `auditMutationsMiddleware`). Distinct from `api-messaging`/`api` on
 * purpose — each M2M domain gets its OWN system user.
 *
 * Molde EXACTO `bootstrapApiMessagingUser` — mismo mecanismo
 * (`bootstrapMachineUser`), UNUSABLE passwordHash inyectada, idempotente por
 * `login`.
 */
import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { bootstrapMachineUser, BootstrapMachineUserResult } from './bootstrapMachineUser';
import { API_SURICATA_USER_LOGIN } from '@domain/constants/machineUsers';

export { API_SURICATA_USER_LOGIN };
export const API_SURICATA_USER_NAME = 'Api Suricata';
export const API_SURICATA_USER_EMAIL = 'api-suricata@sistema.local';

export type BootstrapApiSuricataUserResult = BootstrapMachineUserResult;

export async function bootstrapApiSuricataUser(
  userRepo: RbacUserRepository,
  opts: { passwordHash: string },
): Promise<BootstrapApiSuricataUserResult> {
  return bootstrapMachineUser(userRepo, {
    login: API_SURICATA_USER_LOGIN,
    name: API_SURICATA_USER_NAME,
    email: API_SURICATA_USER_EMAIL,
    passwordHash: opts.passwordHash,
  });
}
