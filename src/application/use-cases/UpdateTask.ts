import { SchedulingRepository, UpdateTaskInput } from '@domain/ports/SchedulingRepository';
import { ScheduledTask } from '@domain/entities/scheduling';
import { EntityLookup } from '@domain/ports/EntityLookup';
import { ProjectKindLookup } from '@domain/ports/ProjectKindLookup';
import { ReferenceNotFoundError, ProjectKindMismatchError, NetworkTaskAddressRequiredError, NetworkTaskLocalityRequiredError, NetworkTaskNodeNameRequiredError, NetworkTypeImmutableError } from '@domain/errors/scheduling';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import { IClassAutoAssigner } from '@domain/ports/IClassAutoAssigner';
import { computeUpdateTaskActivities } from './computeUpdateTaskActivities';
import { SYSTEM_ACTOR } from './taskActivityActor';
import { normalizeOnuSerial } from '@domain/services/fiberProvisioning';

export class UpdateTask {
  constructor(
    private readonly repo: SchedulingRepository,
    private readonly customerLookup: EntityLookup,
    private readonly contractLookup: EntityLookup,
    private readonly partnerLookup: EntityLookup,
    private readonly adminLookup: EntityLookup,
    private readonly projectLookup: ProjectKindLookup,
    private readonly recorder?: TaskActivityRecorder,
    /**
     * AD-2: optional best-effort IClass auto-assigner collaborator.
     * Injected by the composition root (app.ts). When present, UpdateTask
     * invokes maybeAssign ONLY when assigneeId changes, inside a try/catch
     * that NEVER propagates — the local update always completes.
     */
    private readonly autoAssigner?: IClassAutoAssigner,
  ) {}

  async execute(id: string, data: UpdateTaskInput, actor?: ActorContext): Promise<ScheduledTask | null> {
    // #41 — legacy isClosed → generalStatus. generalStatus explicit WINS if both present (D4).
    // Done before the snapshot so the diff sees a single canonical generalStatus change.
    if (data.generalStatus === undefined && data.isClosed !== undefined) {
      data = { ...data, generalStatus: data.isClosed ? 'closed' : 'open' };
    }

    // K3 (fiber-auto-watcher) — onuSerial SIEMPRE canónico al persistir (UPPERCASE, sin
    // espacios): el watcher matchea contra este valor y un serial "sucio" jamás matchearía.
    // Se normaliza ACÁ (no solo en el Zod de la ruta) para cubrir a cualquier caller interno.
    // Vacío tras normalizar → null (equivale a limpiar).
    if (typeof data.onuSerial === 'string') {
      const normalized = normalizeOnuSerial(data.onuSerial);
      data = { ...data, onuSerial: normalized === '' ? null : normalized };
    }

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

    // #66 — networkType is IMMUTABLE post-create. It is an IDENTITY discriminator
    // (red vs fibra), not a mutable state: switching would leave a dangling FK
    // (red→fibra) or accept-and-ignore a site change (fibra→red). Reject any CHANGE.
    // Change-not-presence: the FE edit form resubmits the FULL body on every save
    // (including the unchanged networkType), so echoing the SAME value is a no-op
    // (mirrors the #40 projectId same-id no-op). We only load the task in this branch.
    if ('networkType' in data && (data as { networkType?: 'red' | 'fibra' | null }).networkType != null) {
      const incoming = (data as { networkType?: 'red' | 'fibra' | null }).networkType;
      const existing = await this.repo.getTask(id);
      // Existing network tasks always carry a concrete networkType ('red' default).
      // Only fire on a real mismatch against an existing network task.
      if (existing?.kind === 'network' && existing.networkType != null && incoming !== existing.networkType) {
        throw new NetworkTypeImmutableError();
      }
    }

    // #53 (fix wave #53/#54) — The address guard must fire on a real CHANGE, not
    // on mere presence. The detail page ALWAYS echoes `address` in the PUT, so a
    // legacy network task with a null address would otherwise become un-editable:
    // any save (assignee, date) would re-send address=null and trip a 422.
    // Rule: a blank incoming value is only rejected when it CLEARS an existing
    // value. If the task's address was ALREADY blank/null, re-sending blank is a
    // no-op and must pass. We load the task only in this branch.
    if ('address' in data && data.address !== undefined) {
      const isBlank = data.address === null || data.address === '' || (typeof data.address === 'string' && !data.address.trim());
      if (isBlank) {
        const existing = await this.repo.getTask(id);
        const existingBlank = !existing?.address || !existing.address.trim();
        if (existing?.kind === 'network' && !existingBlank) {
          throw new NetworkTaskAddressRequiredError();
        }
      }
    }

    // #54/#66 — Locality guard: change-not-presence, only for FIBRA tasks.
    // RED tasks no longer require locality (#66 relaxation). FIBRA still does.
    // The effective networkType = incoming (if provided) else existing.
    if ('iclassCityCode' in data && (data as { iclassCityCode?: string | null }).iclassCityCode !== undefined) {
      const cityCode = (data as { iclassCityCode?: string | null }).iclassCityCode;
      const isBlank = cityCode === null || cityCode === '' || (typeof cityCode === 'string' && !cityCode.trim());
      if (isBlank) {
        const existing = await this.repo.getTask(id);
        const existingBlank = !existing?.iclassCityCode || !existing.iclassCityCode.trim();
        // Effective networkType: incoming wins; fall back to existing.
        const effectiveNetworkType = (data as { networkType?: 'red' | 'fibra' | null }).networkType ?? existing?.networkType;
        // Guard only fires for fibra; red tasks are exempt (#66).
        if (existing?.kind === 'network' && !existingBlank && effectiveNetworkType === 'fibra') {
          throw new NetworkTaskLocalityRequiredError();
        }
      }
    }

    // #66 — Node-name guard for fibra tasks (change-not-presence, same as locality).
    if ('networkSiteName' in data && data.networkSiteName !== undefined) {
      const nodeName = data.networkSiteName;
      const isBlank = nodeName === null || nodeName === '' || (typeof nodeName === 'string' && !nodeName.trim());
      if (isBlank) {
        const existing = await this.repo.getTask(id);
        const existingBlank = !existing?.networkSiteName || !existing.networkSiteName.trim();
        const effectiveNetworkType = (data as { networkType?: 'red' | 'fibra' | null }).networkType ?? existing?.networkType;
        if (existing?.kind === 'network' && !existingBlank && effectiveNetworkType === 'fibra') {
          throw new NetworkTaskNodeNameRequiredError();
        }
      }
    }

    // Snapshot the prior state for the diff BEFORE mutating (#10 / D.2).
    // Also used by the auto-assigner guard (load when needed even if recorder is absent).
    const needsPrev = !!(this.recorder || (this.autoAssigner && data.assigneeId !== undefined));
    const prev = needsPrev ? await this.repo.getTask(id) : null;

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

    // AD-2: best-effort IClass auto-assign.
    // Guard: ONLY if assigneeId is in the body AND changed from the prior value.
    // The try/catch is a second safety net — maybeAssign itself NEVER throws,
    // but we wrap it anyway to ensure the local update ALWAYS completes.
    if (
      this.autoAssigner &&
      data.assigneeId !== undefined &&
      updated &&
      prev &&
      updated.assigneeId !== prev.assigneeId
    ) {
      try {
        await this.autoAssigner.maybeAssign(id, updated.assigneeId ?? null, actor);
      } catch {
        // Best-effort: swallow any unexpected error from the assigner.
        // The local update already persisted — never abort it.
      }
    }

    return updated;
  }
}
