import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';
import type { PortalSessionRepository } from '@domain/ports/PortalSessionRepository';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';
import type { PortalTokenService } from '@domain/ports/PortalTokenService';
import { InvalidPortalCredentialsError } from '@domain/errors/portal.errors';
import { generatePortalRefreshToken, hashPortalRefreshToken } from '@domain/services/portalRefreshToken';

/** portal-auth spec: refresh session absolute lifetime — 30 days. */
export const PORTAL_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * H3a (fix wave) — timing-equalizer: hash bcrypt FIJO (cost 10, generado
 * offline sobre un plaintext descartado) contra el que se corre un compare
 * DUMMY en las ramas que no llegan al hash real (DNI inexistente / cuenta
 * disabled). Sin esto, esas ramas respondían sin pagar el costo bcrypt y un
 * atacante podía enumerar DNIs midiendo la latencia del 401.
 */
export const PORTAL_DUMMY_PASSWORD_HASH = '$2b$10$rgHVdMebNFgHpW2718SNWeGwiuHzAXjEAXovOsOT.xvRXGnn12qCK';

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
 * PortalLogin — customer-portal-api (Fase 2, task 2.2 + fix wave H3a).
 *
 * portal-auth spec "Login por DNI + password": DNI inexistente, password
 * incorrecta, y cuenta disabled TODOS lanzan la MISMA InvalidPortalCredentialsError
 * (anti-enumeration). H3a: el mensaje idéntico NO alcanza — las ramas "no
 * existe" y "disabled" respondían sin pagar el bcrypt.compare, filtrando la
 * existencia del DNI por TIMING. Por eso esas ramas ejecutan un compare DUMMY
 * contra `PORTAL_DUMMY_PASSWORD_HASH` (mismo costo, resultado descartado)
 * antes de lanzar el mismo error. Total: SIEMPRE exactamente un compare por
 * intento de login, pase lo que pase.
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
      // H3a — dummy compare: iguala el costo con la rama de password real.
      await this.hasher.compare(input.password, PORTAL_DUMMY_PASSWORD_HASH);
      throw new InvalidPortalCredentialsError();
    }

    if (account.status !== 'active') {
      // H3a — dummy compare contra el hash FIJO (jamás contra el hash real de
      // una cuenta disabled: su password no debe poder "acertarse" ni apagada).
      await this.hasher.compare(input.password, PORTAL_DUMMY_PASSWORD_HASH);
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
