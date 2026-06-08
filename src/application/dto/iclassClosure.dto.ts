import { IClassResultCode } from '@domain/entities/iclass-result-code';
import { IClassClosureConfig } from '@domain/ports/IClassClosureConfigRepository';
import { z } from 'zod';

/** API shape of a result-code catalog entry + its closure mapping. */
export interface ResultCodeDTO {
  id: string;
  soTypeId: string | null;
  code: string;
  type: string;
  mappedStageId: string | null;
  mappedStageName: string | null;
  lastSyncedAt: string; // ISO 8601
}

/** Counts of the last closure-ingest run. */
export interface ClosureRunCounts {
  mirrored: number;
  transitioned: number;
  skippedNotClosed: number;
  skippedNotOurs: number;
  skippedUnchanged: number;
}

/** API shape of the closure-ingest status (GET /closure/status). */
export interface ClosureStatusDTO {
  lastRunAt: string | null; // ISO 8601
  counts: ClosureRunCounts;
}

// ---------------------------------------------------------------------------
// IClass Closure Config DTO
// ---------------------------------------------------------------------------

/** API shape of the IClass closure/autocomplete config — omits raw storage fields. */
export interface IClassClosureConfigDTO {
  closureIntervalMs: number;
  autocompleteIntervalMs: number;
}

export function toIClassClosureConfigDTO(config: IClassClosureConfig): IClassClosureConfigDTO {
  return {
    closureIntervalMs: config.closureIntervalMs,
    autocompleteIntervalMs: config.autocompleteIntervalMs,
  };
}

/** Zod validation schema for PUT /closure/config — floor 60000ms, integer, partial. */
export const UpdateIClassClosureConfigSchema = z.object({
  closureIntervalMs: z.number().int().min(60000),
  autocompleteIntervalMs: z.number().int().min(60000),
}).partial().strict();

export type UpdateIClassClosureConfigInput = z.infer<typeof UpdateIClassClosureConfigSchema>;

// ---------------------------------------------------------------------------

export function toResultCodeDTO(rc: IClassResultCode): ResultCodeDTO {
  return {
    id: rc.id,
    soTypeId: rc.soTypeId,
    code: rc.code,
    type: rc.type,
    mappedStageId: rc.mappedStageId,
    mappedStageName: rc.mappedStageName,
    lastSyncedAt: rc.lastSyncedAt instanceof Date ? rc.lastSyncedAt.toISOString() : rc.lastSyncedAt,
  };
}
