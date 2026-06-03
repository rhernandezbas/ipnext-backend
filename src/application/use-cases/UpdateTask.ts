import { SchedulingRepository, UpdateTaskInput } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ReferenceNotFoundError } from '@domain/errors/scheduling';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { computeUpdateTaskActivities } from './computeUpdateTaskActivities';
import { SYSTEM_ACTOR } from './taskActivityActor';

export class UpdateTask {
  constructor(
    private readonly repo: SchedulingRepository,
    private readonly customerLookup: EntityLookup,
    private readonly contractLookup: EntityLookup,
    private readonly partnerLookup: EntityLookup,
    private readonly adminLookup: EntityLookup,
    private readonly projectLookup: EntityLookup,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async execute(id: string, data: UpdateTaskInput, actor?: ActorContext): Promise<ScheduledTask | null> {
    // FK validation — only for FKs PRESENT in the partial body (not undefined)
    // canonical order: customer → contract → partner → reporter → assignee → watchers
    if (data.customerId !== undefined && data.customerId !== null) {
      const found = await this.customerLookup.findById(data.customerId);
      if (!found) throw new ReferenceNotFoundError('customer', data.customerId);
    }
    if (data.contractId !== undefined && data.contractId !== null) {
      const found = await this.contractLookup.findById(data.contractId);
      if (!found) throw new ReferenceNotFoundError('contract', data.contractId);
    }
    if (data.partnerId !== undefined && data.partnerId !== null) {
      const found = await this.partnerLookup.findById(data.partnerId);
      if (!found) throw new ReferenceNotFoundError('partner', data.partnerId);
    }
    if (data.projectId !== undefined && data.projectId !== null) {
      const found = await this.projectLookup.findById(data.projectId);
      if (!found) throw new ReferenceNotFoundError('project', data.projectId);
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

    // Snapshot the prior state for the diff BEFORE mutating (#10 / D.2).
    const prev = this.recorder ? await this.repo.getTask(id) : null;

    const updated = await this.repo.updateTask(id, data);

    if (this.recorder && prev && updated) {
      const events = computeUpdateTaskActivities(prev, data, actor ?? SYSTEM_ACTOR);
      if (events.length > 0) {
        await this.recorder.recordMany(id, events);
      }
    }

    return updated;
  }
}
