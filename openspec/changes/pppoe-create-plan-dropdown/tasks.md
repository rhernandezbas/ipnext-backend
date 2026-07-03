# Tasks: Dropdown de planes (obligatorio) en "Cargar PPPoE"

> TDD estricto (Vitest): red → green → refactor. FE-puro (repo `ipnext-frontend`). Sin cambios de BE.
> Archivo objetivo: `src/pages/customers/tabs/contracts/InternetPanel.tsx` (sub-componente `CreatePppoeForm`).
> Patrón a reusar: `SpeedControl` (mismo archivo, ~líneas 492-611). Mocks: espejar `InternetPanel.speedControl.test.tsx`.

## 0. Setup del test (TDD)
- [ ] Crear `src/__tests__/contracts/InternetPanel.createPlan.test.tsx`.
- [ ] Copiar el harness de `InternetPanel.speedControl.test.tsx`: `vi.mock('@/hooks/usePlans')`, `usePppoe`, `useNas`, `useMyPermissions`, `useContractServices`, fixtures `PLANS`, `makeQC`, `renderPanel`.
- [ ] Ajuste clave del harness: `useContractPppoe` devuelve `data: []` (sin PPPoE activo) → el panel renderiza `CreatePppoeForm`. Helper que expande la `CollapsibleSection "Cargar PPPoE"` (click en el header) antes de assertear.
- [ ] `useCreatePppoe` mock con `mutateAsync` espía (capturar el body del submit).

## 1. Tests RED (escribir primero, deben fallar)
- [ ] **CP-1**: con `PLANS`, el form Crear muestra un `<select>` con options filtradas (`enabled` + no-`Corte`); excluye `Corte` y `disabled`.
- [ ] **CP-2**: las `<option>` tienen `value = plan.code` y label `name — rateLimit`.
- [ ] **CP-3**: "Crear PPPoE" deshabilitado mientras `profile === ''` (aun con usuario/pass/router completos).
- [ ] **CP-4**: elegir plan + completar usuario/pass/router → "Crear PPPoE" habilitado.
- [ ] **CP-5**: submit → `create.mutateAsync` recibe `profile: '<plan.code>'` (el code, NO el nombre).
- [ ] **CP-6**: `usePlans` vacío (`[]`) → fallback a `<input>` de texto (no `<select>`); el form sigue presente; con code tipeado + datos, el botón se habilita y el submit manda ese code.
- [ ] **CP-7**: `usePlans` `isError` → fallback sin crash; el form sigue vivo.
- [ ] **CP-8 (regresión)**: el `<select>` de Router y el toggle Tipo de IP siguen presentes; alternar el toggle no cambia las options de plan.

## 2. Implementación GREEN (`CreatePppoeForm`)
- [ ] Importar/usar `usePlans()` dentro de `CreatePppoeForm`; computar `eligiblePlans = (plansQuery.data ?? []).filter(p => p.status === 'enabled' && p.category !== 'Corte')`.
- [ ] `const plansUnavailable = plansQuery.isError || eligiblePlans.length === 0`.
- [ ] Reemplazar el bloque del `<input id="pppoe-profile">` (líneas ~374-386):
  - Rama normal: `<select id="pppoe-profile" className={styles.select}>` con `<option value="">Elegí un plan…</option>` + `eligiblePlans.map(...)` (value=`plan.code`, label `name — rateLimit`), `required`, `disabled={create.isPending}`.
  - Rama fallback (`plansUnavailable`): `<input id="pppoe-profile" className={styles.input}>` requerido + `placeholder="Código del plan (ej. IP-Air-30-30)"` + hint `styles.ipHintError` "No se pudo cargar la lista de planes — escribí el código exacto".
  - Label: "Plan" con marcador `*` (`<span aria-hidden="true">*</span>`), igual que Usuario/Router.
- [ ] Botón "Crear PPPoE" (líneas ~464-475): sumar `!form.profile` a la condición `disabled`.
- [ ] Submit (línea ~300): `profile: form.profile.trim()` (sigue requerido; trim defensivo) — quitar el `|| undefined`.
- [ ] Reset post-éxito (línea ~304): mantener `profile: ''` (ya está).

## 3. Tests GREEN
- [ ] Correr `InternetPanel.createPlan.test.tsx` → todos en verde.
- [ ] Correr la suite de `InternetPanel.*` completa → sin regresiones (speedControl, enforce, editPolish, adopt, callerId, deassociate, statusVocab, iptype).

## 4. Refactor + a11y (ui-ux-pro-max)
- [ ] Confirmar que `.select` cumple touch target ≥44px y `:focus-visible` (mismo control que Router/Velocidad — sin tocar CSS si ya cumple).
- [ ] Contraste de la option placeholder = igual a "Elegí un router…" (ya cumple).
- [ ] Verificar que NO se duplicó lógica de filtrado: el filtro `eligiblePlans` es idéntico al de `SpeedControl` (si se vuelve a usar mucho, considerar extraer un helper `getEligiblePlans(plans)` — opcional, no bloqueante).

## 5. Verificación final
- [ ] `vitest` verde (nuevo + suite InternetPanel sin romper).
- [ ] `tsc`/typecheck limpio (sin `any` nuevos; usar tipos `PlanDto`).
- [ ] Lint limpio.
- [ ] Commit conventional: `fix(pppoe): plan dropdown obligatorio en Cargar PPPoE (reemplaza perfil texto libre)`.

## 6. Pendiente de verificación visual (cuando haya entorno)
- [ ] Playwright/manual: el dropdown lista los planes reales; sin plan no se puede crear; crear con plan → PPPoE OK (sin 422); caída de `/plans` → fallback a input.

## Salida
- [ ] "Cargar PPPoE" exige elegir un plan real de un dropdown; el 422-por-plan-vacío deja de ser posible desde el FE; degradación graceful si los planes no cargan.
