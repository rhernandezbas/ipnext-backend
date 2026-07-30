/**
 * portal-auth DTOs — customer-portal-api (Fase 2, task 2.6).
 *
 * Both use-case results already match this exact wire shape (no Prisma/domain
 * entity leaks either way), but the DTO type is declared separately so the HTTP
 * contract is pinned independently of the use case's internal return type — the
 * "DTOs siempre" rule of the repo (`CLAUDE.md`), not merely re-exporting.
 */
export interface PortalLoginResponseDto {
  accessToken: string;
  refreshToken: string;
  mustChangePassword: boolean;
}

export interface PortalRefreshResponseDto {
  accessToken: string;
  refreshToken: string;
}
