# Tasks — network-site-fixed-code (#51)

## BE
- [ ] 1. Migración `20260706000000_network_site_number` (sequence + add col nullable + backfill idempotente + setval + default nextval + NOT NULL + UNIQUE). Sin BEGIN/COMMIT.
- [ ] 2. schema.prisma: `NetworkSite.siteNumber Int @unique @default(dbgenerated("nextval('network_site_number_seq')"))`.
- [ ] 3. Entidad `NetworkSite`: agregar `siteNumber: number` + `fixedCode: string`.
- [ ] 4. Port `NetworkSiteRepository.create`: firma `Omit<NetworkSite,'id'|'siteNumber'|'fixedCode'>`.
- [ ] 5. PrismaNetworkSiteRepository.toSite: `siteNumber`, `fixedCode = "NODO "+siteNumber`. create() sin siteNumber.
- [ ] 6. InMemoryNetworkSiteRepository: contador siteNumber autoincremental en create; seeds con siteNumber+fixedCode; computa fixedCode.
- [ ] 7. SyncUispMirror create call: ya no pasa siteNumber (firma nueva lo omite) — verificar compila.
- [ ] 8. Tests BE (TDD): toSite mapper fixedCode; in-memory create asigna siteNumber; PUT ignora fixedCode; dispatch network sin cambios (regresión).

## FE
- [ ] 9. Tipo NetworkSite FE: + siteNumber, fixedCode.
- [ ] 10. UispNodeMappingBody: columna "Código" muestra fixedCode (badge mono, read-only); localidad sigue editable (select #45); dirección con hint "coordenadas UISP" cuando address vacía y hay coordinates.
- [ ] 11. Tests FE (Vitest): render fixedCode badge; hint UISP en dirección fallback.

## Gates
- [ ] 12. `npx tsc --noEmit` BE; suites networking/uisp/scheduling targeted.
- [ ] 13. FE typecheck + Vitest settings targeted.
