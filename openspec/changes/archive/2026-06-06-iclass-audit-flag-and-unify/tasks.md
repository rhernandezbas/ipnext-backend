# Tasks — iclass-audit-flag-and-unify (#7)

Strict TDD (red→green). BE primero, deploy con verify completo (regla de oro). FE después.

## Backend (ipnext-backend)

- [ ] **1. Test RED — `AuditInstallationQuality` gateado por flag** (`src/__tests__/application/AuditInstallationQuality.test.ts`)
  - Caso A: flag `iclass-audit` OFF (o ausente) → `execute` retorna `null`, el auditor stub NO se invoca, nada se persiste.
  - Caso B: flag ON → corre y persiste (comportamiento actual).
  - Usar `InMemoryFeatureFlagRepository`. Ajustar los tests existentes del use-case para sembrar el flag ON (así siguen verdes).
- [ ] **2. GREEN — gate en el use-case** (`src/application/use-cases/AuditInstallationQuality.ts`)
  - `export const AUDIT_FLAG_KEY = 'iclass-audit'`.
  - Constructor: 5º param `flags: FeatureFlagRepository`.
  - `execute()`: `const flag = await this.flags.get(AUDIT_FLAG_KEY); if (!flag?.enabled) return null;` antes de `getTask`.
- [ ] **3. Wiring — auditor instanciado siempre** (`src/infrastructure/scheduling/closureSideEffects.ts`)
  - Quitar `if (config.audit.enabled)`. Instanciar `AuditInstallationQuality` siempre, pasando `new PrismaFeatureFlagRepository()` como 5º arg (config Ollama del env intacta).
  - `rg "new AuditInstallationQuality\("` → actualizar TODO call-site con el flags repo.
- [ ] **4. Config — retirar el gate del env** (`src/infrastructure/config.ts` + `env.example`)
  - Sacar `audit.enabled` (deja de leer `ICLASS_AUDIT_ENABLED` para gatear). Mantener `ollamaBaseUrl`/`model`/`timeoutMs`. Anotar en `env.example` que el flag `iclass-audit` reemplaza al env.
- [ ] **5. Migración seed** (`prisma/migrations/<ts>_seed_iclass_audit_flag/migration.sql`, ts > `20260604150000`)
  - `INSERT INTO "FeatureFlag" ('iclass-audit', false, NOW()) ON CONFLICT ("key") DO NOTHING;` (copiar patrón de `seed_closure_reprocess_flag`).
- [ ] **6. Verify BE** — `tsc --noEmit` (exit 0) + `npx jest --runInBand` (verde). Recién entonces commit + deploy (OK del usuario) + confirmar run en `gh` (incluido el step de migraciones).

## Frontend (ipnext-frontend)

- [ ] **7. Test RED + GREEN — toggle del auditor IA** (`IClassClosureFlagBody`)
  - Extender `mockFlags` para una 3ª key (`iclass-audit`).
  - Tests: (a) el toggle refleja el flag; (b) clickear llama `setFlag({ key: 'iclass-audit', enabled: true })`; (c) sin `iclass.manage` la card del auditor no se renderiza.
  - GREEN: card "Auditoría de IA" con toggle (`useFeatureFlag`/`useSetFeatureFlag`) dentro de `<Can permission="iclass.manage">`, estética `statusCard`/`switch`.
- [ ] **8. Unificar sub-tabs** (`IClassSettingsBody`)
  - `SUB_TABS` 5 → 4: eliminar `{ id: 'resultados' }`; `content` de `cierre` = `<><IClassClosureFlagBody /><IClassResultCodeMappingBody /></>`. Actualizar JSDoc.
  - Test: las sub-tabs son 4 y "Cierre de OS" incluye el contenido del mapeo de resultados (no existe la tab "Mapeo de resultados").
- [ ] **9. Verify FE** — `tsc --noEmit` (exit 0) + `npx vitest run` (verde). Commit + deploy (OK del usuario) + confirmar run en `gh`.

## Cierre

- [ ] **10. Archive + docs** — `sdd-archive` (merge spec a `openspec/specs/`, mover change a `archive/`). Commit del `BACKLOG.md` (que ya trae #17→hecho, #21, #22) marcando además #7 → hecho.
