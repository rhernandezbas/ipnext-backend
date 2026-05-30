import { SchedulingRepository, CreateTaskInput } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';

export class CreateTask {
  constructor(
    private readonly repo: SchedulingRepository,
    private readonly customerLookup: EntityLookup,
    private readonly serviceLookup: EntityLookup,
    private readonly partnerLookup: EntityLookup,
    private readonly adminLookup: EntityLookup,
    private readonly projectLookup: EntityLookup,
  ) {}

  async execute(data: CreateTaskInput): Promise<ScheduledTask> {
    // FK validation in deterministic order (REQ-FK-ORDER-1):
    // customer → service → partner → reporter → assignee → watchers[*]
    // REQ-REQUIRED-1/2: customerId and serviceId are always required on create.
    // The DTO schema guarantees they are non-null strings; the ! asserts that contract.
    {
      const cid = data.customerId!;
      const found = await this.customerLookup.findById(cid);
      if (!found) throw new ReferenceNotFoundError('customer', cid);
    }
    {
      const sid = data.serviceId!;
      const found = await this.serviceLookup.findById(sid);
      if (!found) throw new ReferenceNotFoundError('service', sid);
    }
    if (data.partnerId != null) {
      const found = await this.partnerLookup.findById(data.partnerId);
      if (!found) throw new ReferenceNotFoundError('partner', data.partnerId);
    }
    if (data.projectId != null) {
      const found = await this.projectLookup.findById(data.projectId);
      if (!found) throw new ReferenceNotFoundError('project', data.projectId);
    }
    if (data.reporterId != null) {
      const found = await this.adminLookup.findById(data.reporterId);
      if (!found) throw new ReferenceNotFoundError('reporter', data.reporterId);
    }
    if (data.assigneeId != null) {
      const found = await this.adminLookup.findById(data.assigneeId);
      if (!found) throw new ReferenceNotFoundError('assignee', data.assigneeId);
    }
    if (data.watcherIds && data.watcherIds.length > 0) {
      for (const watcherId of data.watcherIds) {
        const found = await this.adminLookup.findById(watcherId);
        if (!found) throw new ReferenceNotFoundError('watcher', watcherId);
      }
    }

    return this.repo.createTask(data);
  }
}
