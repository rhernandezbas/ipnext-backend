import { SchedulingRepository, UpdateTaskInput } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ProjectKindLookup } from '@domain/ports/ProjectKindLookup';
import { ReferenceNotFoundError, ProjectKindMismatchError } from '@domain/errors/scheduling';
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
    private readonly projectLookup: ProjectKindLookup,
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
      // #40 — the project↔kind guard must fire on REASSIGNMENT, not on mere
      // presence. The FE edit form resubmits the FULL body on every save,
      // including the UNCHANGED projectId; if a project was later flagged
      // isNetworkProject=true, naively guarding on presence would make a
      // customer task un-editable (422 on each save). So we load the task FIRST
      // and short-circuit when the incoming projectId equals the current one:
      // no reassignment → skip the lookup AND the guard entirely (the FK already
      // points there, re-validating is a wasted query). When the ids differ it
      // is a real move: a single lookup verifies existence AND the network flag,
      // then the symmetric guard rejects a customer↔network mismatch.
      const current = await this.repo.getTask(id);
      if (current && data.projectId !== current.projectId) {
        const project = await this.projectLookup.findById(data.projectId);
        if (!project) throw new ReferenceNotFoundError('project', data.projectId);
        const wantsNetwork = current.kind === 'network';
        if (wantsNetwork !== project.isNetworkProject) {
          throw new ProjectKindMismatchError(data.projectId, current.kind);
        }
      }
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
      // Resolve watcher names for the diff (#17): only the ids that actually
      // changed (added or removed), via the same admin lookup used to validate
      // them. A miss leaves the event nameless (the feed degrades gracefully).
      let watcherNames: Record<string, string> | undefined;
      if (data.watcherIds !== undefined) {
        const prevSet = new Set(prev.watcherIds);
        const nextSet = new Set(data.watcherIds);
        const changed = [
          ...data.watcherIds.filter(w => !prevSet.has(w)),
          ...prev.watcherIds.filter(w => !nextSet.has(w)),
        ];
        if (changed.length > 0) {
          watcherNames = {};
          for (const wId of changed) {
            const found = await this.adminLookup.findById(wId);
            if (found?.name) watcherNames[wId] = found.name;
          }
        }
      }
      const events = computeUpdateTaskActivities(prev, data, actor ?? SYSTEM_ACTOR, updated, watcherNames);
      if (events.length > 0) {
        await this.recorder.recordMany(id, events);
      }
    }

    return updated;
  }
}
