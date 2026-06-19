/**
 * Puerto hacia el plano de control del router (RouterOS API).
 * Lo implementan `RouterOsGateway` (node-routeros, runtime) e `InMemoryRouterGateway` (tests).
 * Las CREDENCIALES (user/pass del router) son server-side: el adapter las resuelve de
 * env/config — NUNCA viajan por este port ni por la capa HTTP.
 */

export interface NasTarget {
  ipAddress: string;
  apiPort: number;
}

export interface RouterSecret {
  username: string;
  profile: string | null;
  remoteAddress: string | null;
  disabled: boolean;
}

export interface SecretInput {
  username: string;
  password: string;
  profile?: string | null;
  remoteAddress?: string | null;
  disabled?: boolean;
}

export interface ActiveSession {
  username: string;
  address: string | null;
  callerId: string | null;
  uptime: string | null;
}

export interface PppoeRouterGateway {
  // --- Fase B (management): implementados ahora ---
  listSecrets(nas: NasTarget): Promise<RouterSecret[]>;
  createSecret(nas: NasTarget, input: SecretInput): Promise<void>;
  updateSecret(nas: NasTarget, username: string, patch: Partial<SecretInput>): Promise<void>;
  removeSecret(nas: NasTarget, username: string): Promise<void>;
  // --- Fase C (enforcement): declarados aquí, se implementan en los cortes ---
  listActiveSessions(nas: NasTarget): Promise<ActiveSession[]>;
  removeActiveSession(nas: NasTarget, username: string): Promise<void>;
  /**
   * IPs actualmente asignadas en el router: los `remote-address` NO vacíos de `/ppp secret`.
   * Lo usa el allocator (FindFreeIp) como fuente de verdad VIVA de IPs ocupadas.
   */
  listAssignedIps(nas: NasTarget): Promise<string[]>;
}
