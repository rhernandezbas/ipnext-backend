import type { ActorContext } from '@domain/ports/TaskActivityRecorder';

/**
 * Fallback actor for activity events emitted without an authenticated user
 * (system/automatic paths). Routes pass the real `req.user`-derived actor.
 */
export const SYSTEM_ACTOR: ActorContext = { actorId: null, actorName: 'System' };
