import { SchedulingRepository, CreateTaskInput } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ProjectKindLookup } from '@domain/ports/ProjectKindLookup';
import { ReferenceNotFoundError, ProjectKindMismatchError, NetworkTaskAddressRequiredError, NetworkTaskLocalityRequiredError, NetworkTaskNodeNameRequiredError, FibraTaskNoSiteError } from '@domain/errors/scheduling';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { NetworkSiteRepository } from '@domain/ports/NetworkSiteRepository';
import { SYSTEM_ACTOR } from './taskActivityActor';

export class CreateTask {
  constructor(
    private readonly repo: SchedulingRepository,
    private readonly customerLookup: EntityLookup,
    private readonly contractLookup: EntityLookup,
    private readonly partnerLookup: EntityLookup,
    private readonly adminLookup: EntityLookup,
    private readonly projectLookup: ProjectKindLookup,
    private readonly ticketLookup?: EntityLookup,
    private readonly recorder?: TaskActivityRecorder,
    private readonly networkSiteRepo?: NetworkSiteRepository,
  ) {}

  async execute(data: CreateTaskInput, actor?: ActorContext): Promise<ScheduledTask> {
    // network-node-task (#29): branch validation por kind.
    if (data.kind === 'network') {
      // #66 — Default networkType to 'red' when not provided.
      const networkType = data.networkType ?? 'red';

      // #53 — all network tasks (red and fibra) require a non-blank address.
      if (!data.address || !data.address.trim()) {
        throw new NetworkTaskAddressRequiredError();
      }

      if (networkType === 'fibra') {
        // FIBRA path: no networkSiteId FK lookup; requires free-text node name + locality.
        // #66 — Reject the hybrid fibra+site shape (second seam layer; the DTO
        // superRefine is the first). A fibra task must NOT carry a networkSiteId:
        // the JOIN would win over the free-text name, and a bad siteId → Prisma 500.
        const siteId = (data as { networkSiteId?: string | null }).networkSiteId;
        if (siteId != null && (typeof siteId !== 'string' || siteId.trim() !== '')) {
          throw new FibraTaskNoSiteError();
        }
        const nodeName = data.networkSiteName;
        if (nodeName == null || (typeof nodeName === 'string' && !nodeName.trim())) {
          throw new NetworkTaskNodeNameRequiredError();
        }
        const cityCode = (data as { iclassCityCode?: string | null }).iclassCityCode;
        if (cityCode == null || (typeof cityCode === 'string' && !cityCode.trim())) {
          throw new NetworkTaskLocalityRequiredError();
        }
      } else {
        // RED path (networkType 'red' or null): validate networkSiteId FK exists.
        const siteId = data.networkSiteId!;
        const site = await this.networkSiteRepo?.findById(siteId);
        if (!site) throw new ReferenceNotFoundError('networkSite', siteId);
        // #54 — locality (iclassCityCode) is now OPTIONAL for red tasks (#66 relaxation).
        // Dispatch can fall back to site.city for back-compat.
      }
      // customer y contract son null por diseño — no hay nada que validar.
    } else {
      // Modo CUSTOMER (rama original, byte-identical):
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
    }
    if (data.partnerId != null) {
      const found = await this.partnerLookup.findById(data.partnerId);
      if (!found) throw new ReferenceNotFoundError('partner', data.partnerId);
    }
    if (data.projectId != null) {
      // #40 — single lookup verifies existence AND resolves the network flag,
      // then enforces the symmetric project↔kind guard (no extra query).
      const project = await this.projectLookup.findById(data.projectId);
      if (!project) throw new ReferenceNotFoundError('project', data.projectId);
      const wantsNetwork = data.kind === 'network';
      if (wantsNetwork !== project.isNetworkProject) {
        throw new ProjectKindMismatchError(data.projectId, data.kind ?? 'customer');
      }
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

    const task = await this.repo.createTask(data);

    // task-activity-log (#10 / D.1): emit `created`. Best-effort — the recorder
    // swallows its own errors, so this never aborts task creation.
    if (this.recorder) {
      await this.recorder.record(task.id, 'created', {
        actor: actor ?? SYSTEM_ACTOR,
        toValue: {
          title: task.title,
          stageId: task.stageId,
          priority: task.priority,
          category: task.category,
          assigneeId: task.assigneeId,
          watcherIds: task.watcherIds,
        },
      });
    }

    return task;
  }
}
