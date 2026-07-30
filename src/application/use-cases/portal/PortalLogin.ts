import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';
import type { PortalSessionRepository } from '@domain/ports/PortalSessionRepository';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';
import type { PortalTokenService } from '@domain/ports/PortalTokenService';
import { InvalidPortalCredentialsError } from '@domain/errors/portal.errors';
import { generatePortalRefreshToken, hashPortalRefreshToken } from '@domain/services/portalRefreshToken';

/** portal-auth spec: refresh session absolute lifetime — 30 days. */
export const PORTAL_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface PortalLoginInput {
  dni: string;
  password: string;
}

export interface PortalLoginResult {
  accessToken: string;
  refreshToken: string;
  mustChangePassword: boolean;
}

/**
 * PortalLogin — customer-portal-api (Fase 2, task 2.2).
 *
 * portal-auth spec "Login por DNI + password": DNI inexistente, password
 * incorrecta, y cuenta disabled TODOS lanzan la MISMA InvalidPortalCredentialsError
 * (anti-enumeration) — el orden de chequeos (existencia → status → password) sigue
 * el mismo criterio que LoginRbacUser (rechazar disabled ANTES del bcrypt.compare
 * evita el costo de hashing en cuentas que nunca van a pasar, y evita filtrar
 * "activo vs disabled" por timing).
 */
export class PortalLogin {
  constructor(
    private readonly accounts: PortalAccountRepository,
    private readonly sessions: PortalSessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly tokenService: PortalTokenService,
    /** Clock seam for deterministic tests. */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: PortalLoginInput): Promise<PortalLoginResult> {
    const account = await this.accounts.findByDni(input.dni);
    if (!account) {
      throw new InvalidPortalCredentialsError();
    }

    if (account.status !== 'active') {
      throw new InvalidPortalCredentialsError();
    }

    const validPassword = await this.hasher.compare(input.password, account.passwordHash);
    if (!validPassword) {
      throw new InvalidPortalCredentialsError();
    }

    const now = this.now();
    await this.accounts.update(account.id, { lastLoginAt: now });

    const accessToken = this.tokenService.signAccessToken({ accountId: account.id, clientId: account.clientId });
    const refreshToken = generatePortalRefreshToken();
    await this.sessions.create({
      accountId: account.id,
      tokenHash: hashPortalRefreshToken(refreshToken),
      expiresAt: new Date(now.getTime() + PORTAL_REFRESH_TOKEN_TTL_MS),
    });

    return { accessToken, refreshToken, mustChangePassword: account.mustChangePassword };
  }
}
