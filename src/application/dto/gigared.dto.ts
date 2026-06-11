import { z } from 'zod';

/**
 * Gigared TV DTOs (#47).
 *
 * The full apiKey JAMÁS sale en respuestas — GigaredConfigDTO exposes only `configured`
 * + `apiKeyLast4`. The masking is done in GetGigaredConfig/UpdateGigaredConfig use cases.
 */

export interface GigaredConfigDTO {
  configured: boolean;
  apiKeyLast4: string | null;
  baseUrl: string;
  enabled: boolean;
  updatedAt: string | null;
}

/**
 * Result of AddTvService / RemoveTvService.
 * `gigared: 'ok'` always (the upstream call succeeded before we touch local state).
 * `local: 'failed'` → router responds 207 TV_LOCAL_SYNC_FAILED (retry = re-POST, idempotent).
 */
export interface AddTvServiceResult {
  gigared: 'ok';
  local: 'ok' | 'failed';
  contractServiceId?: string;
  localError?: string;
}

export type RemoveTvServiceResult = AddTvServiceResult;

/**
 * PUT /api/gigared/config body. Every field optional:
 *   - apiKey omitted = no change; '' = clear the key (unconfigured)
 *   - baseUrl must be a valid URL when present
 *   - enabled toggles the `gigared-integration` feature flag
 */
export const updateGigaredConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  enabled: z.boolean().optional(),
});

export type UpdateGigaredConfigBody = z.infer<typeof updateGigaredConfigSchema>;
