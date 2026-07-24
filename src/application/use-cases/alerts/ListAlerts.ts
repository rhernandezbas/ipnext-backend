import { NocAlert } from '@domain/entities/nocAlert';
import { NocAlertRepository, NocAlertListFilters } from '@domain/ports/NocAlertRepository';

export class ListAlerts {
  constructor(private readonly repo: NocAlertRepository) {}

  execute(filters: NocAlertListFilters): Promise<NocAlert[]> {
    return this.repo.list(filters);
  }
}
