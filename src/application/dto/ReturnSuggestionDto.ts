import { ReturnSuggestion } from '@domain/entities/return-suggestion';

/**
 * Operator-facing view of a closure-detected return suggestion (EPIC #38 W4).
 * Never leaks raw entity internals beyond what the FE needs to render the card.
 */
export interface ReturnSuggestionDto {
  id: string;
  taskId: string;
  serviceOrderId: string;
  serialNumber: string | null;
  mac: string | null;
  deviceType: string | null;
  matchedAssetId: string | null;
  status: string;
  resolution: string | null;
  createdAt: string;
}

export function toReturnSuggestionDto(s: ReturnSuggestion): ReturnSuggestionDto {
  return {
    id: s.id,
    taskId: s.taskId,
    serviceOrderId: s.serviceOrderId,
    serialNumber: s.serialNumber,
    mac: s.mac,
    deviceType: s.deviceType,
    matchedAssetId: s.matchedAssetId,
    status: s.status,
    resolution: s.resolution,
    createdAt: s.createdAt,
  };
}
