# Design — iclass-audit-flag-and-unify (#7)

## Backend

### Dónde va el gate del flag (decisión clave)
El auditor (`AuditInstallationQuality`) es invocado por **dos** paths: el closure-loop normal y el reprocess manual, ambos vía `buildClosureSideEffects()`. Para que el flag aplique a los dos y sea toggleable sin redeploy, el gate va **dentro del use-case**, no en la instanciación ni en cada caller.

- **Elegido**: `AuditInstallationQuality.execute()` consulta `flags.get('iclass-audit')` al inicio y hace early-return `null` si OFF. Cohesivo (el use-case del auditor conoce su propio flag), DIP-correcto (depende del port `FeatureFlagRepository`), un solo lugar gatea ambos paths. Costo: una lectura de flag por OS auditada — trivial (lookup por PK `key`), mismo costo que el reprocess.
- **Rechazado A — gate estático en `closureSideEffects` (`if flag.enabled` al instanciar)**: se evalúa una sola vez al arrancar → NO toggleable sin redeploy. Es justo lo que queremos eliminar del env.
- **Rechazado B — gate en `IngestClosedServiceOrders`**: el ingest tendría que conocer el flag específico del auditor → mezcla responsabilidades; además habría que duplicarlo en el path del reprocess.

### Cambios BE
1. **`AuditInstallationQuality`** (`application/use-cases/`):
   - `export const AUDIT_FLAG_KEY = 'iclass-audit'`.
   - Constructor suma 5º param `private readonly flags: FeatureFlagRepository`.
   - `execute()`: primero `const flag = await this.flags.get(AUDIT_FLAG_KEY); if (!flag?.enabled) return null;` (antes de `getTask`).
2. **`closureSideEffects.ts`**:
   - Quitar `if (config.audit.enabled)`. Instanciar `AuditInstallationQuality` **siempre**, con la config Ollama del env y `new PrismaFeatureFlagRepository()` como 5º arg.
3. **`config.ts`**: retirar `audit.enabled` (el env `ICLASS_AUDIT_ENABLED` deja de leerse para el gate). Mantener `ollamaBaseUrl`/`model`/`timeoutMs`. Actualizar `env.example` (anotar que el flag reemplaza al env).
4. **Migración** `prisma/migrations/<ts>_seed_iclass_audit_flag/migration.sql` (ts posterior a `20260604150000`): `INSERT INTO "FeatureFlag" ('iclass-audit', false, NOW()) ON CONFLICT ("key") DO NOTHING`. Aditiva → segura.
5. **Otros call-sites**: `rg "new AuditInstallationQuality\("` — agregarles el flags repo. (Esperado: solo `closureSideEffects.ts`; el reprocess reusa `buildClosureSideEffects`. Confirmar en apply.)

### Tests BE (TDD)
- `AuditInstallationQuality.test.ts`: (a) flag OFF → `execute` retorna `null` y el auditor stub NO se invoca; (b) flag ON → corre y persiste (comportamiento actual intacto). Usar `InMemoryFeatureFlagRepository` (existe) + stubs in-memory de los demás ports. Los tests actuales del use-case deben pasar el flag ON para seguir verdes.

## Frontend

### Unificación (mantener diseño)
- **`IClassClosureFlagBody`**: sumar una card nueva "Auditoría de IA" con un toggle cableado al flag `iclass-audit` (reusa `useFeatureFlag`/`useSetFeatureFlag`), dentro de `<Can permission="iclass.manage">` (mismo gate que la card de reprocess). Misma estética (`statusCard`, `switch`).
- **`IClassSettingsBody`**: `SUB_TABS` pasa de 5 → 4. Se elimina la entrada `{ id: 'resultados', … }`; el `content` de `cierre` pasa a `<><IClassClosureFlagBody /><IClassResultCodeMappingBody /></>` (fragment) para mostrar el mapeo de resultados dentro de la misma sub-page. Actualizar el JSDoc (hoy dice "tres sub-secciones").

### Tests FE (Vitest)
- `IClassClosureFlagBody.test.tsx`: (a) el toggle del auditor refleja el flag `iclass-audit` (independiente de los otros flags — extender `mockFlags` para una 3ª key); (b) clickearlo llama `setFlag` con `{ key: 'iclass-audit', enabled: true }`; (c) sin `iclass.manage` la card del auditor no se renderiza.
- `IClassSettingsBody.test.tsx` (si existe; si no, mínimo): las sub-tabs son 4 y "Cierre de OS" incluye el contenido del mapeo de resultados. Si no hay test previo, agregar uno chico que verifique que no existe la tab "Mapeo de resultados".

## Riesgos / mitigaciones
- **Flag default OFF** → tras el deploy el auditor queda apagado hasta prenderlo en UI (cambio explícito vs el env de hoy). Mitigación: prenderlo post-deploy desde la UI (como closure-loop). Documentar en el PR.
- **Migración**: aditiva, idempotente → segura, push directo (regla de migraciones).
- **Multi-repo**: BE primero (flag + endpoint ya existe), FE después; verify completo antes de cada deploy.
