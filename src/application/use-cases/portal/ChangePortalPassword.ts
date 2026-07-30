import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';
import type { PortalSessionRepository } from '@domain/ports/PortalSessionRepository';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';
import {
  PortalAccountNotFoundError,
  InvalidCurrentPortalPasswordError,
  PortalPasswordTooShortError,
} from '@domain/errors/portal.errors';

/** portal-auth spec "Cambio de password in-app": minimo 8 caracteres. */
const MIN_PASSWORD_LENGTH = 8;

export interface ChangePortalPasswordInput {
  accountId: string;
  currentPassword: string;
  newPassword: string;
}

/**
 * ChangePortalPassword — customer-portal-api (Fase 2, task 2.3 + fix wave M1).
 *
 * portal-auth spec "Cambio de password in-app": exige la password actual, valida
 * la nueva (>=8 chars) y limpia `mustChangePassword` — el mecanismo por el que un
 * cliente sale del estado "nació con password autogenerada" tras su primer login.
 *
 * M1: tras cambiar el hash REVOCA todas las sesiones de la cuenta (mismo
 * criterio que RegeneratePortalPassword/SetPortalAccountStatus) — si el cliente
 * cambia la password porque sospecha robo, el refresh token robado debe morir
 * con la password vieja. El cliente se re-loguea con la nueva.
 */
export class ChangePortalPassword {
  constructor(
    private readonly accounts: PortalAccountRepository,
    private readonly hasher: PasswordHasher,
    private readonly sessions: PortalSessionRepository,
  ) {}

  async execute(input: ChangePortalPasswordInput): Promise<void> {
    const account = await this.accounts.findById(input.accountId);
    if (!account) {
      throw new PortalAccountNotFoundError(input.accountId);
    }

    const validCurrent = await this.hasher.compare(input.currentPassword, account.passwordHash);
    if (!validCurrent) {
      throw new InvalidCurrentPortalPasswordError();
    }

    if (input.newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new PortalPasswordTooShortError();
    }

    const newHash = await this.hasher.hash(input.newPassword);
    await this.accounts.update(account.id, { passwordHash: newHash, mustChangePassword: false });

    // M1 — password nueva = sesiones viejas muertas. Después del update: un
    // fallo acá jamás deja la password vieja vigente.
    await this.sessions.revokeAllForAccount(account.id);
  }
}
