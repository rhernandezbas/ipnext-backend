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
import { applyTaskClosure } from './applyTaskClosure';

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

    // Snapshot the prior state for the diff BEFORE mutating (#10 / D.2). wave-1a: also
    // needed whenever this patch CLOSES the task, to know if it's a real open→closed
    // transition (route through the atomic guard) or a no-op on an already-closed one.
    const isClosingPatch = data.generalStatus === 'closed';
    const needsPrev = !!(this.recorder || (this.autoAssigner && data.assigneeId !== undefined) || isClosingPatch);
    const prev = needsPrev ? await this.repo.getTask(id) : null;

    // wave-1a (cierre atómico) — a patch that CLOSES the task routes the closure
    // itself through the atomic guard (origin=staff); every OTHER field in the same
    // patch still applies via the normal updateTask path — the FE resubmits the full
    // body on every save (#40/#53/#54 precedent), so dropping bundled fields here on a
    // close would be a silent data-loss regression, not a fix. `diffData` is what the
    // activity diff engine sees: on a LOST race this writer's status never actually
    // changed, so generalStatus/isClosed are stripped to avoid a phantom status_changed.
    //
    // FIX-3 (fix wave W1a) — ORDER MATTERS, and it is REST FIRST, CLOSE LAST.
    // The first cut did the opposite: it closed the task and THEN wrote the rest. When
    // the rest failed (an invalid `stageId` → the Prisma adapter catches the FK error
    // and returns null), the use case returned null and the route answered 404 "task
    // not found" — with the task ALREADY CLOSED in the database. An irreversible write
    // hidden behind an error response. Inverting it makes both outcomes honest:
    //   - rest fails  → nothing was closed, the task is untouched, the error is true;
    //   - rest succeeds → the atomic close runs last and is the only thing that can
    //     still "fail", and its failure mode is benign (it lost the race; the task is
    //     closed either way, just by someone else).
    // ACCEPTED CONSEQUENCE, documented on purpose: when the close LOSES the race, the
    // rest fields of this patch are ALREADY applied and STAY applied. That is the right
    // trade — those fields are the operator's edit (notes, assignee, dates) and are
    // orthogonal to who won the closure; rolling them back would need a transaction
    // spanning two ports and would throw away work the operator did.
    let updated: ScheduledTask | null;
    let diffData: UpdateTaskInput = data;
    if (isClosingPatch && prev && prev.generalStatus !== 'closed') {
      const { generalStatus: _gs, isClosed: _ic, ...restData } = data;
      const hasRest = Object.keys(restData).length > 0;

      // 1) The write that CAN fail. Bail before closing anything if it did.
      const restUpdated = hasRest ? await this.repo.updateTask(id, restData) : null;
      if (hasRest && !restUpdated) return null;

      // 2) The atomic, irreversible close — last.
      const closeResult = await applyTaskClosure(this.repo, this.recorder, {
        taskId: id,
        origin: 'staff',
        resultCode: null,
        closedByUserId: actor?.actorId ?? null,
      });

      if (!closeResult.closed) {
        diffData = restData;
      }

      // closeResult.task is the freshest read (post-close, and post-rest since the rest
      // ran first); fall back to the rest write when the task vanished mid-flight.
      updated = closeResult.task ?? restUpdated ?? await this.repo.getTask(id);
    } else {
      updated = await this.repo.updateTask(id, data);
    }

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
      const events = computeUpdateTaskActivities(prev, diffData, actor ?? SYSTEM_ACTOR, updated, watcherNames);
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
