import type { PortalAccountRepository } from '@domain/ports/PortalAccountRepository';
import type { PortalSessionRepository } from '@domain/ports/PortalSessionRepository';
import type { PasswordHasher } from '@domain/ports/PasswordHasher';
import { PortalAccountNotFoundError, InvalidCurrentPortalPasswordError } from '@domain/errors/portal.errors';

export interface DeleteMyPortalAccountInput {
  accountId: string;
  /** Confirmación exigida por el spec — la password ACTUAL de la cuenta. */
  password: string;
}

/** portal-account-deletion spec "Auditoría del borrado": accountId, clientId y
 * timestamp — deliberadamente SIN password ni tokens. */
export interface PortalAccountDeletionAuditEvent {
  portalAccountId: string;
  clientId: string;
  deletedAt: string;
}

function defaultAuditLogger(event: PortalAccountDeletionAuditEvent): void {
  // Fallback estructurado — el repo no tiene un modelo/tabla de audit log
  // dedicado (investigado: no existe AuditLog en prisma/schema.prisma). El
  // caller de producción (Fase 7, wiring) puede inyectar un logger real; este
  // console.log estructurado YA cumple el requisito "dejar rastro auditable".
  console.log('[portal] account deleted', event);
}

/**
 * DeleteMyPortalAccount — customer-portal-api (Fase 6, task 6.1).
 *
 * portal-account-deletion spec: exige la password ACTUAL como confirmación
 * (401-equivalente vía `InvalidCurrentPortalPasswordError` si no coincide — la
 * cuenta queda intacta). En éxito: borra TODAS las `PortalSession` de la cuenta
 * (`deleteAllForAccount` — hard delete de las filas, no un revoke) y LUEGO el
 * `PortalAccount`. El `Client` del ISP y su data de negocio (contratos, facturas,
 * tickets, tareas) NUNCA se tocan — este use case no depende de ningún port de
 * `Client`, por construcción no puede alcanzarlo.
 */
export class DeleteMyPortalAccount {
  constructor(
    private readonly accounts: PortalAccountRepository,
    private readonly sessions: PortalSessionRepository,
    private readonly hasher: PasswordHasher,
    private readonly auditLogger: (event: PortalAccountDeletionAuditEvent) => void = defaultAuditLogger,
    /** Clock seam for deterministic tests (mirror PortalLogin/RefreshPortalSession). */
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(input: DeleteMyPortalAccountInput): Promise<void> {
    const account = await this.accounts.findById(input.accountId);
    if (!account) {
      throw new PortalAccountNotFoundError(input.accountId);
    }

    const validPassword = await this.hasher.compare(input.password, account.passwordHash);
    if (!validPassword) {
      throw new InvalidCurrentPortalPasswordError();
    }

    // Sesiones PRIMERO — si algo falla a mitad de camino, es preferible dejar
    // una cuenta sin sesiones (login sigue exigiendo password, sin riesgo) que
    // sesiones huérfanas de una cuenta ya borrada.
    await this.sessions.deleteAllForAccount(account.id);
    await this.accounts.delete(account.id);

    this.auditLogger({
      portalAccountId: account.id,
      clientId: account.clientId,
      deletedAt: this.now().toISOString(),
    });
  }
}
