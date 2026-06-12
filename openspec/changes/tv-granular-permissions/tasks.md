# Tasks — tv-granular-permissions (#50)

## BE
- [ ] T1. Agregar `'link'`,`'register'`,`'packs'`,`'ott'`,`'cancel'` a `KNOWN_ACTIONS` (rbac.ts). Actualizar comentario de conteo.
- [ ] T2. Migración data-only `20260705000000_tv_granular_permissions/migration.sql`: seed 5 permisos tv + grant a administrador (+ super_admin idempotente). ON CONFLICT.
- [ ] T3. `GigaredRouterDeps`: reemplazar `requireWrite` por `requireLink/requireRegister/requirePacks/requireOtt/requireCancel`. Aplicar a cada ruta.
- [ ] T4. `app.ts`: wiring de los 5 nuevos `requirePerm('tv', ...)`.
- [ ] T5. Tests BE (red→green): gigared.routes.test.ts (403 por permiso ajeno + 200 con permiso correcto por ruta), gigared-composition.test.ts, gigared-migration.test.ts (snapshot SQL), rbac domain (acciones nuevas).
- [ ] T6. `npx tsc --noEmit` limpio.

## FE
- [ ] T7. GigaredPanel.tsx: Vincular→tv.link, Registrar→tv.register, packs(add/remove)→tv.packs.
- [ ] T8. GigaredPanel.tsx: PARTIR el `<Can tv.write>` de OTT+baja → Suspender/Reactivar bajo tv.ott; Dar de baja/confirmar/reintentar baja bajo tv.cancel.
- [ ] T9. Tests FE (GigaredPanel.test.tsx) por clave granular. typecheck.

## Verify
- [ ] T10. Suites gigared/rbac BE + FE targeted. tsc/typecheck.
