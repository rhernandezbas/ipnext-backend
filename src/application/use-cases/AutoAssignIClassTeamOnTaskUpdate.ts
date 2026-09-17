import { SchedulingRepository } from '@domain/ports/SchedulingRepository';
import { IClassPort } from '@domain/ports/IClassPort';
import { IClassTeamRepository } from '@domain/ports/IClassTeamRepository';
import { FeatureFlagRepository } from '@domain/ports/FeatureFlagRepository';
import { RbacUserRepository } from '@domain/ports/RbacUserRepository';
import { TaskActivityRecorder, ActorContext } from '@domain/ports/TaskActivityRecorder';
import {
  IClassAutoAssigner,
  AutoAssignOutcome,
  AutoAssignSkipReason,
} from '@domain/ports/IClassAutoAssigner';
import { IClassRejectedError, IClassUnavailableError } from '@domain/errors/iclass';

/** Un mensaje de error de IClass no tiene por qué caber en la columna: lo recortamos. */
const MAX_ERROR_MESSAGE_CHARS = 500;

/**
 * Estados de IClass que NO aceptan escrituras sobre la OS: 7 (Concluída/Encerrado) y
 * 50 (Aprovação). Empujar una OS en 50 devuelve ICLERR_0212 y el operador ve "rechazado"
 * en vez del motivo real. Mismo criterio que PushIClassClosureOnTaskEnd.
 */
const NON_ACTIONABLE_STATUS_CODES = new Set(['7', '50']);

/**
 * AutoAssignIClassTeamOnTaskUpdate — best-effort IClass team auto-assigner.
 *
 * Implements IClassAutoAssigner (AD-2). maybeAssign NEVER throws — all errors
 * are caught and returned as AutoAssignOutcome { outcome: 'failed' }.
 *
 * Flow (design matrix B1-B15):
 * 1. getTask(taskId); not found or no iclassOrderCode → skipped: no-order-code (silencioso:
 *    la tarea nunca estuvo en IClass, no hay divergencia que reportar).
 * 2. assigneeId == null → skipped: unassigned
 * 3. flag 'iclass-assign-action' OFF → skipped: flag-off
 * 5. task.generalStatus !== 'open' → skipped: not-open
 * 6. rbacUserRepo.findById(assigneeId); no iclassTeamLogin → skipped: no-mapping
 * 7. teamRepo.getByLogin(login); absent / !active / !selectable → skipped: team-inactive
 * 8a. sin startDate/endDate → skipped: no-schedule (chequeo LOCAL, va ANTES del pre-check
 *     remoto: una tarea sin ventana nunca se puede empujar, no hay que gastar un
 *     round-trip a IClass — que puede rate-limitar — para terminar en el mismo skip).
 * 8b. getServiceOrder pre-check; null → order-not-found; status 7/50 → order-closed
 * 9. updateServiceOrder → success: assigned + activity; IClassRejectedError → failed: rejected;
 *    IClassUnavailableError → failed: unavailable.
 * 10. Any unexpected error → failed (no throw).
 *
 * Cada skip desde el paso 2 en adelante deja un activity 'iclass_team_auto_assign_skipped':
 * si no, la tarea queda reprogramada en Prominense con la ventana vieja en IClass y nadie
 * se entera hasta que el técnico va el día equivocado.
 */
export class AutoAssignIClassTeamOnTaskUpdate implements IClassAutoAssigner {
  constructor(
    private readonly schedulingRepo: SchedulingRepository,
    private readonly iclass: IClassPort,
    private readonly teamRepo: IClassTeamRepository,
    private readonly flagRepo: FeatureFlagRepository,
    private readonly userRepo: RbacUserRepository,
    private readonly recorder?: TaskActivityRecorder,
  ) {}

  async maybeAssign(
    taskId: string,
    assigneeId: string | null,
    actor?: ActorContext,
  ): Promise<AutoAssignOutcome> {
    try {
      return await this._maybeAssign(taskId, assigneeId, actor);
    } catch (err) {
      // Final safety net: catch-all ensures NEVER throws regardless.
      // Y DEJA RASTRO: el modo de falla más probable acá es el rate-limit de IClass
      // reventando el pre-check. Sin este registro la reprogramación se pierde en
      // silencio — el mismo agujero que este caso de uso viene a tapar.
      await this.recordFailure(taskId, err, actor);
      // El motivo que se devuelve tiene que ser el MISMO que se escribió en la timeline.
      return { outcome: 'failed', reason: err instanceof IClassRejectedError ? 'rejected' : 'unavailable' };
    }
  }

  /** Registra un fallo en la línea de tiempo. Best-effort: nunca propaga. */
  private async recordFailure(
    taskId: string,
    err: unknown,
    actor?: ActorContext,
    teamLogin?: string,
  ): Promise<void> {
    try {
      if (!this.recorder) return;
      const reason = err instanceof IClassRejectedError ? 'rejected' : 'unavailable';
      await this.recorder.record(taskId, 'iclass_team_auto_assign_failed', {
        actor: actor ?? { actorId: null, actorName: 'System' },
        toValue: reason,
        // Sin el mensaje, un rechazo de negocio y una caída se ven idénticos en la
        // línea de tiempo, y no hay forma de saber por qué no se asignó.
        metadata: {
          message: (err instanceof Error ? err.message : String(err)).slice(0, MAX_ERROR_MESSAGE_CHARS),
          ...(teamLogin ? { teamLogin } : {}),
        },
      });
    } catch {
      // ignore recorder error
    }
  }

  private async _maybeAssign(
    taskId: string,
    assigneeId: string | null,
    actor?: ActorContext,
  ): Promise<AutoAssignOutcome> {
    // Step 1: resolve task FIRST — sin saber si la tarea está atada a una OS no se puede
    // decidir si un skip merece quedar registrado o es puro ruido. Si ESTE read falla, el
    // throw sube al catch externo de maybeAssign y SÍ se registra: entre un evento de más
    // en una tarea sin IClass y una reprogramación perdida en silencio, gana dejar rastro.
    const task = await this.schedulingRepo.getTask(taskId);
    if (!task || !task.iclassOrderCode) {
      return { outcome: 'skipped', reason: 'no-order-code' };
    }

    // A partir de acá la tarea SÍ existe en IClass: todo skip se registra.
    const skip = async (reason: AutoAssignSkipReason, teamLogin?: string): Promise<AutoAssignOutcome> => {
      try {
        if (this.recorder) {
          await this.recorder.record(taskId, 'iclass_team_auto_assign_skipped', {
            actor: actor ?? { actorId: null, actorName: 'System' },
            toValue: reason,
            metadata: { reason, ...(teamLogin ? { teamLogin } : {}) },
          });
        }
      } catch {
        // best-effort: nunca romper la actualización de la tarea por la timeline
      }
      return { outcome: 'skipped', reason, ...(teamLogin ? { teamLogin } : {}) };
    };

    // Step 2: null assignee → desassign, skip
    if (assigneeId == null) {
      return skip('unassigned');
    }

    // Step 3: feature flag check
    const flag = await this.flagRepo.get('iclass-assign-action');
    if (!flag?.enabled) {
      return skip('flag-off');
    }

    // Step 5: task must be open
    if (task.generalStatus !== 'open') {
      return skip('not-open');
    }

    // Step 6: resolve technician's team login
    const user = await this.userRepo.findById(assigneeId);
    const teamLogin = user?.iclassTeamLogin ?? null;
    if (!teamLogin) {
      return skip('no-mapping');
    }

    // Step 7: validate team active && selectable
    const team = await this.teamRepo.getByLogin(teamLogin);
    if (!team || !team.active || !team.selectable) {
      return skip('team-inactive', teamLogin);
    }

    // Step 8a: chequeo LOCAL primero — una tarea sin ventana nunca se puede empujar, así
    // que no tiene sentido gastar un round-trip a IClass (que puede rate-limitar) para
    // terminar en el mismo skip igual.
    if (!task.startDate || !task.endDate) {
      return skip('no-schedule', teamLogin);
    }

    // Step 8b: live pre-check via getServiceOrder
    const snapshot = await this.iclass.getServiceOrder(task.iclassOrderCode);
    // "No la encontré" y "está cerrada" se arreglan distinto: no los mezclamos.
    if (!snapshot) {
      return skip('order-not-found', teamLogin);
    }
    if (NON_ACTIONABLE_STATUS_CODES.has(snapshot.statusCode)) {
      return skip('order-closed', teamLogin);
    }

    // Step 9: push team assignment to IClass
    const scheduleStart = new Date(task.startDate);
    const scheduleEnd = new Date(task.endDate);
    try {
      await this.iclass.updateServiceOrder({
        serviceOrderCode: task.iclassOrderCode,
        requiredTeam: teamLogin,
        scheduleStart,
        scheduleEnd,
      });
    } catch (err) {
      await this.recordFailure(taskId, err, actor, teamLogin);
      if (err instanceof IClassRejectedError) {
        return { outcome: 'failed', reason: 'rejected', teamLogin };
      }
      // IClassUnavailableError y cualquier error inesperado: no disponible.
      return { outcome: 'failed', reason: 'unavailable', teamLogin };
    }

    // IClass YA aceptó el push. A partir de acá un recorder caído NO puede convertir
    // esto en "falló": el operador reprogramaría de nuevo algo que ya viajó.
    try {
      if (this.recorder) {
        await this.recorder.record(taskId, 'iclass_team_auto_assigned', {
          actor: actor ?? { actorId: null, actorName: 'System' },
          toValue: teamLogin,
          // Una reprogramación con el MISMO técnico también pasa por acá: sin la ventana
          // el evento parece un cambio de cuadrilla que nunca ocurrió.
          metadata: {
            teamLogin,
            scheduleStart: scheduleStart.toISOString(),
            scheduleEnd: scheduleEnd.toISOString(),
          },
        });
      }
    } catch {
      // ignore recorder error
    }

    return { outcome: 'assigned', teamLogin };
  }
}
