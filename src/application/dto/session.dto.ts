import type { Session } from '@domain/entities/session';

/** Wire shape for a session. MUST NOT expose tokenHash. */
export interface SessionDto {
  id: string;
  rbacUserId: string;
  actorLogin: string;
  ip: string | null;
  userAgent: string | null;
  loginAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  createdAt: string;
}

export interface SessionPageDto {
  items: SessionDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** Explicit field enumeration — tokenHash is intentionally dropped. */
export function toSessionDto(s: Session): SessionDto {
  return {
    id: s.id,
    rbacUserId: s.rbacUserId,
    actorLogin: s.actorLogin,
    ip: s.ip,
    userAgent: s.userAgent,
    loginAt: s.loginAt,
    lastSeenAt: s.lastSeenAt,
    revokedAt: s.revokedAt,
    createdAt: s.createdAt,
  };
}
