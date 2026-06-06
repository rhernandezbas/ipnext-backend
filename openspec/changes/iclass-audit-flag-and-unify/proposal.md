# Proposal — iclass-audit-flag-and-unify (#7)

Mode: interactive · Store: hybrid (openspec + engram `sdd/iclass-audit-flag-and-unify/*`).

## Why

Backlog #7 pide dos cosas sobre la configuración de IClass en Scheduling → Configuraciones:

1. **Unificar la sub-page de "Cierre de OS"**: hoy el flujo de cierre está partido en **dos** sub-tabs separadas ("Cierre de OS" y "Mapeo de resultados") que son del **mismo** concepto. El operador tiene que saltar entre tabs para configurar un solo flujo. Se quiere una sola sub-page que agrupe todo el cierre.

2. **Feature flag del auditor de IA**: hoy el auditor de instalación (closure F6, Ollama vision) se prende/apaga **solo con la env var `ICLASS_AUDIT_ENABLED`** (estática, leída al arrancar → requiere **redeploy** para cambiarla). El closure-loop y el reprocess ya son **feature flags toggleables desde la UI** (`iclass-closure-loop`, `iclass-closure-reprocess`); el auditor es la pieza que quedó afuera del patrón. Se quiere poder prenderlo/apagarlo desde la misma UI, sin redeploy.

## Decisiones (confirmadas con el usuario)

- **AD-1 — Unificación**: una **sola** sub-page "Cierre de OS" que agrupe **closure-loop + reconciliar + reprocess + mapeo de resultados + el nuevo toggle del auditor IA**. Las 5 sub-tabs de IClass pasan a **4** (se absorbe "Mapeo de resultados" dentro de "Cierre de OS"). Se mantiene el diseño existente (cards `statusCard`, no se rediseña).
- **AD-2 — Flag reemplaza al env**: nuevo feature flag DB-backed **`iclass-audit`** que **reemplaza** a `ICLASS_AUDIT_ENABLED` como gate. El env queda **solo** para la config de Ollama (`OLLAMA_BASE_URL`, `AUDIT_MODEL`, timeout). Mismo patrón ya probado (closure-loop/reprocess): seed por migración idempotente (default **OFF**), re-leído en runtime, toggleable en UI.

## What changes

### Backend
- Migración idempotente que siembra el flag `iclass-audit` (default `enabled=false`), patrón `INSERT … ON CONFLICT (key) DO NOTHING` (como `seed_closure_reprocess_flag`).
- El gate del auditor pasa del env al flag: `AuditInstallationQuality` recibe el `FeatureFlagRepository` y hace **early-return** si `iclass-audit` está OFF (re-lectura en runtime, como `ReprocessClosureSideEffects`). El auditor se **instancia siempre** en `closureSideEffects.ts` (con la config Ollama del env); deja de gatearse por `config.audit.enabled`.
- `config.audit.enabled` se retira como gate (el env `ICLASS_AUDIT_ENABLED` deja de decidir; la config Ollama se mantiene).

### Frontend
- `IClassSettingsBody`: las sub-tabs pasan de 5 → 4. "Cierre de OS" agrupa, en una sola sub-page, el contenido de `IClassClosureFlagBody` **+** `IClassResultCodeMappingBody`, **+** una nueva card con el toggle del auditor IA (flag `iclass-audit`), reusando el patrón de toggle existente.
- Nuevo toggle del auditor IA cableado al flag `iclass-audit` vía `useFeatureFlag`/`useSetFeatureFlag` (ya existen).

## Impact

- **Out of scope**: rediseño visual de las cards; cambiar la lógica del auditor (qué/cómo audita — eso es el #20); tocar el closure-loop o el reprocess en sí; permisos nuevos (se reusan `iclass.manage` / los existentes del cierre).
- **Riesgo**: bajo. El flag arranca OFF → el auditor queda apagado tras el deploy hasta que el operador lo prenda (cambio de comportamiento explícito vs hoy, donde el env lo prende). Se documenta y se prende el flag post-deploy (como se hizo con closure-loop).
- **Permisos**: la sección del auditor se gatea con el mismo permiso que el reprocess (`iclass.manage`); el resto del cierre mantiene su gating actual.
- **Sin breaking del API**: el flag usa el endpoint existente `/api/admin/feature-flags`.

## Coordinación multi-repo
- BE y FE = dos changes coordinados (commits independientes por repo), verify completo antes de cada deploy (regla de oro), flag prendido recién post-deploy.
