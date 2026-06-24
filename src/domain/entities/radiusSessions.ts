export interface RadiusSession {
  id: string;
  sessionId: string;
  clientName: string;
  // El orchestrator (GET /sessions) solo expone nasIp; framedIp/callerId pueden venir null.
  // Por eso estos 4 son nullable: la fuente real puede no tenerlos.
  nasId: string | null;
  nasName: string | null;
  ipAddress: string | null;
  macAddress: string | null;
  startedAt: string;
  duration: number;
  downloadBytes: number;
  uploadBytes: number;
  downloadMbps: number;
  uploadMbps: number;
  status: 'active' | 'idle';
  username: string;
  // gestion-red-sessions — cruce a contrato por `username` (pppoe → contract → client).
  // Los 3 en `null` = el PPPoE de la sesión NO tiene contrato asociado → el FE muestra ⚠.
  //
  // `clientId` ahora ES el id del Client REAL resuelto por el cruce (no el id sintético del
  // accounting RADIUS, que nunca fue un Client.id de verdad). El contrato del FE lista `clientId`
  // como campo del cruce; lo unificamos acá. `clientName` (display RADIUS) se conserva intacto.
  contractId: string | null;
  clientId: string | null;
  customerName: string | null;
}
