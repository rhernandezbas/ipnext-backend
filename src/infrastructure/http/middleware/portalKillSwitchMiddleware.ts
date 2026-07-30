import { Request, Response, NextFunction } from 'express';
import type { SettingsRepository } from '@domain/ports/SettingsRepository';

const DEFAULT_CACHE_TTL_MS = 30_000;

/** Only the read this middleware needs — narrower than the full SettingsRepository. */
export type PortalKillSwitchSettingsReader = Pick<SettingsRepository, 'getClientPortalSettings'>;

/**
 * portalKillSwitchMiddleware — customer-portal-api (Fase 2, task 2.5).
 *
 * portal-auth spec "Kill-switch global del portal": if `ClientPortalSettings.enabled
 * !== true` (missing row included — `PrismaSettingsRepository.getClientPortalSettings`
 * self-heals a missing singleton to the default `enabled: false`), EVERY
 * `/api/portal/*` request gets 503 `PORTAL_DISABLED` BEFORE credentials/data are
 * ever touched — this must sit in front of even `/auth/login`.
 *
 * Cached in-memory for `cacheTtlMs` (~30s, design.md §4) so a flood of requests
 * doesn't hammer the settings row once per request. A read failure (DB hiccup)
 * fails CLOSED (503) — "basura al valor SEGURO" (memoria del repo): for a global
 * kill-switch, the safe side of an unknown state is OFF, never silently letting
 * portal traffic through while the settings source is degraded.
 */
export function createPortalKillSwitchMiddleware(
  settingsRepo: PortalKillSwitchSettingsReader,
  cacheTtlMs: number = DEFAULT_CACHE_TTL_MS,
) {
  let cached: { enabled: boolean; at: number } | null = null;

  return async function portalKillSwitchMiddleware(_req: Request, res: Response, next: NextFunction): Promise<void> {
    const now = Date.now();
    if (!cached || now - cached.at > cacheTtlMs) {
      try {
        const settings = await settingsRepo.getClientPortalSettings();
        cached = { enabled: settings.enabled === true, at: now };
      } catch {
        cached = { enabled: false, at: now };
      }
    }

    if (!cached.enabled) {
      res.status(503).json({ error: 'El portal de clientes está deshabilitado', code: 'PORTAL_DISABLED' });
      return;
    }

    next();
  };
}
