import { SchedulingRepository, CreateTaskInput } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';

export class CreateTask {
  constructor(
    private readonly repo: SchedulingRepository,
    private readonly customerLookup: EntityLookup,
    private readonly contractLookup: EntityLookup,
    private readonly partnerLookup: EntityLookup,
    private readonly adminLookup: EntityLookup,
    private readonly projectLookup: EntityLookup,
    private readonly ticketLookup?: EntityLookup,
  ) {}

  async execute(data: CreateTaskInput): Promise<ScheduledTask> {
    // FK validation in deterministic order (REQ-FK-ORDER-1):
    // customer → contract → partner → project → reporter → assignee → watchers[*] → ticket
    // REQ-REQUIRED-1/2: customerId and contractId are always required on create.
    // The DTO schema guarantees they are non-null strings; the ! asserts that contract.
    {
      const cid = data.customerId!;
      const found = await this.customerLookup.findById(cid);
      if (!found) throw new ReferenceNotFoundError('customer', cid);
    }
    {
      const cid = data.contractId!;
      const found = await this.contractLookup.findById(cid);
      if (!found) throw new ReferenceNotFoundError('contract', cid);
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
    // AD-3: optional ticket FK validation — only when ticketLookup injected AND ticketId is set.
    if (this.ticketLookup != null && data.ticketId != null) {
      const found = await this.ticketLookup.findById(data.ticketId);
      if (!found) throw new ReferenceNotFoundError('ticket', data.ticketId);
    }

    return this.repo.createTask(data);
  }
}
