/**
 * #47 — the 'tv' RBAC module must exist in RBAC_MODULES so requirePerm('tv', …) compiles.
 */
import { RBAC_MODULES } from '@domain/entities/rbac';
import type { RbacModuleCode } from '@domain/entities/rbac';

describe("RBAC_MODULES includes 'tv' (#47)", () => {
  it("'tv' is a registered module code", () => {
    expect(RBAC_MODULES).toContain('tv');
  });

  it("'tv' is assignable to RbacModuleCode (type witness)", () => {
    const m: RbacModuleCode = 'tv';
    expect(m).toBe('tv');
  });
});
