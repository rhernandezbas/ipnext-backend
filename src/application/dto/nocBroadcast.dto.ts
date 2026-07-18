import { z } from 'zod';
import {
  NocBroadcastConfig,
  isNocBroadcastConfigured,
} from '@domain/ports/NocBroadcastConfigRepository';

// ── Read DTO (masked credentials) ────────────────────────────────────────────

/**
 * Outbound config DTO. The raw `evolutionApiKey` is NEVER serialized — the read
 * surface exposes only `hasApiKey` + `apiKeyLast4` (credential-masking pattern of
 * the repo). Shape-distinct from the domain `NocBroadcastConfig` so the wire
 * contract can evolve independently of storage.
 */
export interface NocBroadcastConfigDTO {
  enabled: boolean;
  evolutionBaseUrl: string;
  evolutionInstance: string;
  targetChat: string;
  appPublicUrl: string;
  /** True when a non-empty apiKey is stored (the key itself is never sent). */
  hasApiKey: boolean;
  /** Last 4 chars of the stored key (or null if none / shorter than 4) — for a masked hint. */
  apiKeyLast4: string | null;
  /** Convenience for the settings card: enabled + all Evolution fields set. */
  configured: boolean;
}

export function toNocBroadcastConfigDTO(config: NocBroadcastConfig): NocBroadcastConfigDTO {
  const key = config.evolutionApiKey;
  return {
    enabled: config.enabled,
    evolutionBaseUrl: config.evolutionBaseUrl,
    evolutionInstance: config.evolutionInstance,
    targetChat: config.targetChat,
    appPublicUrl: config.appPublicUrl,
    hasApiKey: key !== '',
    apiKeyLast4: key.length >= 4 ? key.slice(-4) : null,
    configured: isNocBroadcastConfigured(config),
  };
}

// ── Update input validation (PUT /config) ────────────────────────────────────

/**
 * URL fields accept an http(s) URL OR an empty string (clear / leave-default).
 * `.url()` alone accepts ANY scheme (WHATWG) — including `javascript:` — so we
 * pin the protocol: `evolutionBaseUrl` is an HTTP target and `appPublicUrl` is a
 * deep-link base, neither of which should ever be a non-http(s) scheme.
 */
const optionalUrl = z
  .string()
  .url()
  .refine((v) => /^https?:\/\//i.test(v), { message: 'must be an http(s) URL' })
  .or(z.literal(''));

/**
 * Inbound PUT body. Every field optional (partial update). URL fields are
 * validated as URL-or-empty. `evolutionApiKey` is a plain string here (empty
 * allowed at the shape level); the use-case treats an empty/absent key as
 * "preserve the stored one" — a PUT of other fields must never wipe the secret.
 */
export const UpdateNocBroadcastConfigSchema = z
  .object({
    enabled: z.boolean(),
    evolutionBaseUrl: optionalUrl,
    evolutionApiKey: z.string(),
    evolutionInstance: z.string(),
    targetChat: z.string(),
    appPublicUrl: optionalUrl,
  })
  .partial();

export type UpdateNocBroadcastConfigInput = z.infer<typeof UpdateNocBroadcastConfigSchema>;
