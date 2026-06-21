import { ContractRepository, ContractLocationResult } from '@domain/ports/ContractRepository';
import { InvalidLocationError } from '@domain/errors/geolocation';
import { ContractNotFoundError } from '@domain/errors/contractServices';
import { validateLat, validateLng, validatePlusCode } from './geoValidation';

export interface UpdateContractLocationCommand {
  id: string;
  gpsLat?: number | null;
  gpsLng?: number | null;
  gpsPlusCode?: string | null;
}

/**
 * Updates the Prominense-owned GPS location on a Contract.
 * Fields whitelisted: gpsLat, gpsLng, gpsPlusCode.
 * GR lat/lng are NEVER touched — they remain as-is and continue to sync from GR.
 * Throws ContractNotFoundError if the contract does not exist.
 * Throws InvalidLocationError if lat/lng are out of range or plusCode is malformed.
 */
export class UpdateContractLocation {
  constructor(private readonly contractRepo: ContractRepository) {}

  async execute(cmd: UpdateContractLocationCommand): Promise<ContractLocationResult> {
    validateLat(cmd.gpsLat);
    validateLng(cmd.gpsLng);
    validatePlusCode(cmd.gpsPlusCode);

    const updated = await this.contractRepo.updateLocation(cmd.id, {
      gpsLat: cmd.gpsLat,
      gpsLng: cmd.gpsLng,
      gpsPlusCode: cmd.gpsPlusCode,
    });

    if (!updated) {
      throw new ContractNotFoundError(cmd.id);
    }

    return updated;
  }
}

export { InvalidLocationError };
