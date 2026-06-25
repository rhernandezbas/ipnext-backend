export type RadiusAuthReply = 'Access-Accept' | 'Access-Reject';

export interface RadiusAuthEvent {
  id: string;
  sourceUniqueId: string;
  username: string;
  reply: RadiusAuthReply;
  authdate: string;        // ISO 8601
  class: string | null;
  /** Motivo del rechazo congelado al ingestar: 'user_not_found' | 'session_stuck' | 'other'. null para Access-Accept o históricos viejos. */
  reason: string | null;
  createdAt: string;       // ISO 8601
  updatedAt: string;       // ISO 8601
}
