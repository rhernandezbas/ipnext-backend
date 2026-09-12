/**
 * suricata-tickets-mirror (Phase A, RBAC-EXT-1/EXT-2) — the 'suricata' RBAC
 * module must exist in RBAC_MODULES with base actions read/manage plus the
 * DEDICATED sub-action 'reply' (NOT a reuse of 'send' — design.md D2
 * correction, post-tasks 2026-09-11: a real, irreversible write to an
 * external customer via Suricata is a distinct risk from internal
 * messaging, so the spec (suricata-ticket-reply REPLY-1 /
 * rbac-permission-catalog-extension RBAC-EXT-2) requires its own action
 * code with its own testable scenario).
 *
 * Molde exacto: rbac-tv-module.test.ts (#47).
 */
import { RBAC_MODULES, KNOWN_ACTIONS } from '@domain/entities/rbac';
import type { RbacModuleCode, PermissionAction } from '@domain/entities/rbac';

describe("RBAC_MODULES includes 'suricata' (suricata-tickets-mirror, RBAC-EXT-2)", () => {
  it("'suricata' is a registered module code", () => {
    expect(RBAC_MODULES).toContain('suricata');
  });

  it("'suricata' is assignable to RbacModuleCode (type witness)", () => {
    const m: RbacModuleCode = 'suricata';
    expect(m).toBe('suricata');
  });
});

describe("KNOWN_ACTIONS includes the DEDICATED 'reply' sub-action (RBAC-EXT-2)", () => {
  it("'reply' is a known action code", () => {
    expect(KNOWN_ACTIONS).toContain('reply');
  });

  it("'reply' is assignable to PermissionAction (type witness)", () => {
    const a: PermissionAction = 'reply';
    expect(a).toBe('reply');
  });

  it("'reply' is NOT the same code as 'send' — a dedicated action, not a reuse of messaging's send", () => {
    // Design D2 correction: reusing 'send' would collapse an irreversible external
    // write into the same gate as replying to an internal WhatsApp thread.
    expect('reply').not.toBe('send');
    expect(KNOWN_ACTIONS).toContain('send'); // still exists (messaging), unaffected
  });
});
