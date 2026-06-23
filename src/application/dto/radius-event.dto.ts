/**
 * DTOs de la API de eventos RADIUS (Logs RADIUS + Auditoría NE8000).
 *
 * Reglas:
 * - bytesIn / bytesOut como string (BigInt no es JSON-safe).
 * - sourceUniqueId NUNCA se expone (clave interna de idempotencia).
 * - Ne8000AuditRowDto NO incluye password ni radiusSecret.
 */

// ── RadiusEventDto ─────────────────────────────────────────────────────────────

export interface RadiusEventDto {
  id: string;
  username: string;
  nasId: string | null;
  nasIpAddress: string;
  nasName: string | null;          // nombre del NasServer; null si no hay match
  framedIp: string | null;
  macAddress: string | null;
  vlanId: number | null;
  startedAt: string;               // ISO 8601
  stoppedAt: string | null;        // ISO 8601, null = sesión activa
  sessionTimeSeconds: number | null;
  inOctets: string;                // BigInt serializado como string
  outOctets: string;               // BigInt serializado como string
  eventType: 'start' | 'stop' | 'interim';
  status: 'online' | 'closed';
  online: boolean;                 // alias de (stoppedAt === null)
}

export interface PaginatedRadiusEventsDto {
  data: RadiusEventDto[];
  total: number;
  page: number;
  limit: number;
  hasNext: boolean;
}

// ── Ne8000AuditRowDto ──────────────────────────────────────────────────────────

export interface Ne8000AuditRowDto {
  pppoeId: string;
  username: string;
  profile: string | null;           // plan comercial
  remoteAddress: string | null;     // IP fija asignada
  macAddress: string | null;        // PppoeService.callerId (última MAC conocida)
  status: string;                   // enabled | disabled
  enforcedState: string;            // active | reduced | blocked
  contractId: string | null;
  currentlyOnline: boolean;         // tiene un RadiusEvent con stoppedAt=null
  lastStartedAt: string | null;     // ISO 8601 — startedAt del evento más reciente
  lastStoppedAt: string | null;     // ISO 8601 — stoppedAt del último evento CERRADO
  lastFramedIp: string | null;      // framedIp del evento más reciente
  lastVlanId: number | null;        // vlanId del evento más reciente
}

export interface PaginatedNe8000AuditDto {
  data: Ne8000AuditRowDto[];
  total: number;
  page: number;
  limit: number;
  hasNext: boolean;
}
