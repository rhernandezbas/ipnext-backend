import { CustomerRepository } from '@domain/ports/CustomerRepository';
import { Customer } from '@domain/entities/customer';
import { ClientNotFoundError } from '@domain/errors';
import { validateLat, validateLng, validatePlusCode } from './geoValidation';

export interface UpdateClientLocationCommand {
  id: string;
  lat?: number | null;
  lng?: number | null;
  plusCode?: string | null;
}

/**
 * Updates the Prominense-owned GPS location on a Client.
 * Fields whitelisted: lat, lng, plusCode.
 * GR fields (name, address, status, etc.) are NEVER touched.
 * Throws ClientNotFoundError if the client does not exist.
 * Throws InvalidLocationError if lat/lng are out of range or plusCode is malformed.
 */
export class UpdateClientLocation {
  constructor(private readonly customerRepo: CustomerRepository) {}

  async execute(cmd: UpdateClientLocationCommand): Promise<Customer> {
    validateLat(cmd.lat);
    validateLng(cmd.lng);
    validatePlusCode(cmd.plusCode);

    const updated = await this.customerRepo.updateLocation(cmd.id, {
      lat: cmd.lat,
      lng: cmd.lng,
      plusCode: cmd.plusCode,
    });

    if (!updated) {
      throw new ClientNotFoundError(cmd.id);
    }

    return updated;
  }
}
