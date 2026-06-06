# Spec delta — iclass-audit-flag-and-unify (#7)

Capability afectada: configuración y gating del cierre de OS de IClass (auditor IA + sub-page de settings).

## ADDED Requirements

### Requirement: REQ-AUDIT-FLAG-1 — El auditor IA se gatea por el flag `iclass-audit` (runtime)
El auditor de instalación (closure F6) DEBE gatearse por un feature flag DB-backed `iclass-audit`, re-leído en cada ejecución (toggle sin redeploy).

#### Scenario: flag OFF → no se audita
- **WHEN** se ejecuta `AuditInstallationQuality.execute` y el flag `iclass-audit` está `enabled=false` (o no existe)
- **THEN** el use-case retorna `null` SIN llamar al auditor (Ollama) ni persistir nada, y la auditoría previa (si la hay) sobrevive.

#### Scenario: flag ON → audita normal
- **WHEN** se ejecuta `AuditInstallationQuality.execute` y el flag `iclass-audit` está `enabled=true`
- **THEN** el use-case corre el auditor y persiste el resultado con el comportamiento soft-fail actual (ok=false no persiste; sin hallazgos persiste un `ok` sintético).

#### Scenario: aplica a closure normal y a reprocess
- **WHEN** el flag `iclass-audit` está OFF
- **THEN** ni el closure-loop ni el reprocess (`iclass-closure-reprocess`) disparan la auditoría — el gate vive en el use-case compartido, no en cada caller.

### Requirement: REQ-AUDIT-FLAG-2 — Seed idempotente del flag (default OFF)
El flag `iclass-audit` DEBE sembrarse por migración idempotente con `enabled=false`.

#### Scenario: migración re-aplicable
- **WHEN** corre la migración de seed (incluso más de una vez)
- **THEN** existe la fila `FeatureFlag('iclass-audit', false)` y re-correrla no la pisa (`ON CONFLICT ("key") DO NOTHING`).

### Requirement: REQ-AUDIT-FLAG-3 — El env deja de gatear; la config Ollama se mantiene
`ICLASS_AUDIT_ENABLED` DEJA de decidir si el auditor corre. La config de Ollama del auditor (baseUrl/model/timeout) se mantiene desde el env.

#### Scenario: auditor instanciado siempre
- **WHEN** se compone `buildClosureSideEffects`
- **THEN** `auditInstallation` se instancia siempre (con la config Ollama del env), independiente de `ICLASS_AUDIT_ENABLED`; el gate es el flag en runtime.

### Requirement: REQ-UNIFY-1 — Una sola sub-page "Cierre de OS"
La config de IClass (Scheduling → Configuraciones → IClass) DEBE tener **4** sub-tabs. "Cierre de OS" agrupa closure-loop + reconciliar + reprocess + **mapeo de resultados** + el toggle del auditor IA.

#### Scenario: no existe la sub-tab "Mapeo de resultados" separada
- **WHEN** se renderiza `IClassSettingsBody`
- **THEN** las sub-tabs son Integración · Catálogo · Mapeo de proyectos · Cierre de OS (4); el contenido del mapeo de resultados se muestra dentro de "Cierre de OS".

### Requirement: REQ-UNIFY-2 — Toggle del auditor IA en la UI
La sub-page "Cierre de OS" DEBE exponer un toggle que refleje y cambie el flag `iclass-audit`, gateado por `iclass.manage`.

#### Scenario: refleja el flag
- **WHEN** `iclass-audit` está ON/OFF
- **THEN** el toggle aparece checked/unchecked acorde, y al clickearlo llama a `setFeatureFlag({ key: 'iclass-audit', enabled: !actual })`.

#### Scenario: gateado por permiso
- **WHEN** el usuario no tiene `iclass.manage`
- **THEN** la card del auditor IA no se renderiza (igual que la sección de reprocess).

## Out of scope
- Rediseño visual de las cards (se mantiene el diseño existente).
- Cambiar QUÉ/CÓMO audita el modelo (eso es el #20).
- Permisos nuevos (se reusan los existentes).
