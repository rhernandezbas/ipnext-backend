import { SchedulingRepository, UpdateTaskInput } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';

export class UpdateTask {
  constructor(
    private readonly repo: SchedulingRepository,
    private readonly customerLookup: EntityLookup,
    private readonly serviceLookup: EntityLookup,
    private readonly partnerLookup: EntityLookup,
    private readonly adminLookup: EntityLookup,
  ) {}

  async execute(id: string, data: UpdateTaskInput): Promise<ScheduledTask | null> {
    // FK validation — only for FKs PRESENT in the partial body (not undefined)
    // canonical order: customer → service → partner → reporter → assignee → watchers
    if (data.customerId !== undefined && data.customerId !== null) {
      const found = await this.customerLookup.findById(data.customerId);
      if (!found) throw new ReferenceNotFoundError('customer', data.customerId);
    }
    if (data.serviceId !== undefined && data.serviceId !== null) {
      const found = await this.serviceLookup.findById(data.serviceId);
      if (!found) throw new ReferenceNotFoundError('service', data.serviceId);
    }
    if (data.partnerId !== undefined && data.partnerId !== null) {
      const found = await this.partnerLookup.findById(data.partnerId);
      if (!found) throw new ReferenceNotFoundError('partner', data.partnerId);
    }
    if (data.reporterId !== undefined && data.reporterId !== null) {
      const found = await this.adminLookup.findById(data.reporterId);
      if (!found) throw new ReferenceNotFoundError('reporter', data.reporterId);
    }
    if (data.assigneeId !== undefined && data.assigneeId !== null) {
      const found = await this.adminLookup.findById(data.assigneeId);
      if (!found) throw new ReferenceNotFoundError('assignee', data.assigneeId);
    }
    if (data.watcherIds !== undefined && data.watcherIds.length > 0) {
      for (const watcherId of data.watcherIds) {
        const found = await this.adminLookup.findById(watcherId);
        if (!found) throw new ReferenceNotFoundError('watcher', watcherId);
      }
    }

    return this.repo.updateTask(id, data);
  }
}
