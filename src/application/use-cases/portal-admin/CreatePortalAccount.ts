import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';
import type { ClientPortalLookup } from '@domain/ports/ClientPortalLookup';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';
import { ClientNotFoundError } from '@domain/errors';
import {
  PortalDniAlreadyUsedError,
  PortalAccountAlreadyExistsError,
  PortalAccountDniRequiredError,
} from '@domain/errors/portalAdmin.errors';
import { generatePortalPassword } from '@domain/services/generatePortalPassword';
import type { CreatePortalAccountResponseDto } from '@application/dto/portal/portalAccountAdmin.dto';
import { toPortalAccountAdminDto } from '@application/dto/portal/portalAccountAdmin.dto';

export interface CreatePortalAccountInput {
  clientId: string;
  /** Operator override — takes precedence over `customAttributes.documento`. */
  dni?: string;
}

/**
 * CreatePortalAccount — customer-portal-api (Fase 3, task 3.1).
 *
 * portal-accounts-admin spec "Crear cuenta con password autogenerada": 100%
 * manual provisioning by staff. Check order (fail fast on the cheapest/most
 * fundamental invariant first):
 *   1. Client exists                              → 404 ClientNotFoundError
 *   2. clientId doesn't already have an account    → 409 PortalAccountAlreadyExistsError
 *   3. dni resolves (override > mirror documento)  → 422 PortalAccountDniRequiredError
 *   4. dni isn't already used by another account    → 409 PortalDniAlreadyUsedError
 *
 * The password is shown in PLAIN TEXT exactly once, in this method's return
 * value — only the bcrypt hash is ever persisted. Never logged (no console.log
 * anywhere near `password` in this file, on purpose).
 */
export class CreatePortalAccount {
  constructor(
    private readonly accounts: PortalAccountRepository,
    private readonly clients: ClientPortalLookup,
    private readonly hasher: PasswordHasher,
    /** Seam for deterministic tests — defaults to the real crypto generator. */
    private readonly generatePassword: () => string = generatePortalPassword,
  ) {}

  async execute(input: CreatePortalAccountInput): Promise<CreatePortalAccountResponseDto> {
    const client = await this.clients.findById(input.clientId);
    if (!client) {
      throw new ClientNotFoundError(input.clientId);
    }

    const existingForClient = await this.accounts.findByClientId(input.clientId);
    if (existingForClient) {
      throw new PortalAccountAlreadyExistsError(input.clientId);
    }

    const overrideDni = input.dni?.trim();
    const dni = overrideDni && overrideDni.length > 0 ? overrideDni : client.documento;
    if (!dni) {
      throw new PortalAccountDniRequiredError();
    }

    const existingForDni = await this.accounts.findByDni(dni);
    if (existingForDni) {
      throw new PortalDniAlreadyUsedError(dni);
    }

    const password = this.generatePassword();
    const passwordHash = await this.hasher.hash(password);

    const account = await this.accounts.create({ clientId: input.clientId, dni, passwordHash });

    return { ...toPortalAccountAdminDto(account), password };
  }
}
