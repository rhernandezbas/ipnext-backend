import type { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import type { UserRoleLookup } from '@domain/ports/UserRoleLookup';
import { isTechnicalRoleSet } from '@domain/entities/rbac';
import type { AssignableUserDto } from '@application/dto/messaging';

/**
 * ListAssignableUsers (F1.5-C2, asignación) — pool asignable para el dropdown
 * de `GET /messaging/assignable-users`. Reusa la MISMA regla única de
 * "asignable" ya establecida por `recapture-assignable-roles`
 * (openspec/changes/recapture-assignable-roles/design.md) y consumida por el
 * hook FE `useAssignableOperators`:
 *
 *   asignable(user) := user.status === 'active'
 *                   && roleCodes.length > 0
 *                   && !isTechnicalRoleSet(roleCodes)
 *
 * Depende de `UserRoleLookup` (mismo puerto minimal que
 * `AssignRecaptureLeadsBulk`) en vez de `RbacUserRepository.listRolesForUser`
 * directo — mantiene la capa de aplicación desacoplada de un método que en el
 * adapter in-memory es solo un stub de test para otros flujos, y espeja
 * exactamente el wiring de `roleLookupForRecapture` en app.ts (reusado, no
 * duplicado).
 *
 * `RbacUserRepository.list()` no pagina (pool admin chico, <100 — mismo
 * criterio que `ListRbacUsers`), así que el filtro es O(n) sin N+1 real.
 *
 * NUNCA expone passwordHash/email/login — el DTO es {id, name} nada más.
 */
export class ListAssignableUsers {
  constructor(
    private readonly userRepo: RbacUserRepository,
    private readonly roleLookup: UserRoleLookup,
  ) {}

  async execute(): Promise<AssignableUserDto[]> {
    const allUsers = await this.userRepo.list();
    const result: AssignableUserDto[] = [];

    for (const user of allUsers) {
      if (user.status !== 'active') continue;

      const codes = await this.roleLookup.listRoleCodes(user.id);
      if (codes.length === 0 || isTechnicalRoleSet(codes)) continue;

      result.push({ id: user.id, name: user.name });
    }

    return result;
  }
}
