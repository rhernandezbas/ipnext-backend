# Proposal: Dropdown de planes (obligatorio) en "Cargar PPPoE" (Crear PPPoE)

## Intent

Reemplazar el campo **"Perfil"** de **texto libre opcional** del form **"Cargar PPPoE"** por un **`<select>` de planes de Prominense, OBLIGATORIO** — reusando el mismo patrón que ya usa `SpeedControl` para cambiar el plan de un PPPoE existente.

## Why

El form de Crear PPPoE (`InternetPanel.tsx`, sub-componente `CreatePppoeForm`) tiene el campo Perfil como **texto libre opcional**:

- Render: `<input id="pppoe-profile">` (líneas ~375-386), `placeholder="Opcional"`, sin `required`.
- Estado: `profile: ''` en el `form` (línea 243).
- Submit (línea 300): `profile: form.profile.trim() || undefined` → el profile viaja **opcional**.

PERO el orchestrator de PPPoE (BE → `CreatePppoeService` → radius-orchestrator) define **`plan` como OBLIGATORIO** (`CreateUserRequest.plan: str = Field(min_length=1)`). Crear sin plan → el orchestrator devuelve **422** → axios lo lanza → el FE cae en la rama genérica `else` del `catch` (líneas 308-313) y muestra *"No se pudo cargar el PPPoE. Revisá los datos e intentá de nuevo."*. El operador no sabe que el problema es el plan vacío.

Además, texto libre permite tipear un perfil que **no existe** en Prominense (typo, código viejo), produciendo el mismo 422 o un PPPoE inconsistente. El dropdown elimina la clase entera de error: solo se puede elegir un plan **real, habilitado**.

El patrón correcto YA existe en el MISMO archivo: `SpeedControl` (líneas ~492-611) hace exactamente esto para **cambiar** el plan — `usePlans()` → `eligiblePlans` (filtra `status === 'enabled' && category !== 'Corte'`) → `<select>` con `<option key={plan.id} value={plan.code}>{plan.name ? \`${plan.name} — ${plan.rateLimit}\` : \`${plan.code} — ${plan.rateLimit}\`}</option>` → manda `plan.code`. El form de Crear debe **reusar el mismo patrón**.

## Scope

### In Scope (FE-puro)

- **`CreatePppoeForm`** en `InternetPanel.tsx`:
  - Reemplazar el `<input id="pppoe-profile">` por un `<select>` **obligatorio**, poblado con `usePlans()` y filtrado igual que `eligiblePlans` de `SpeedControl` (`status === 'enabled' && category !== 'Corte'`).
  - `<option value={plan.code}>` → manda el **`code`** del plan (ej. `IP-Air-30-30`), nunca el nombre.
  - Default: el dropdown arranca **sin plan elegido** (option placeholder "Elegí un plan…", value `''`), espejando el `<select>` de Router que ya tiene "Elegí un router…".
  - Validación: el botón **"Crear PPPoE"** se deshabilita hasta elegir un plan (sumar `!form.profile` a la condición `disabled` de la línea ~467-472). El submit manda `profile: form.profile` (ya no `|| undefined`, porque es requerido).
  - **Degradación graceful** (espejo de `SpeedControl`, líneas 543-555): si `plansQuery.isError || eligiblePlans.length === 0` → **no se puede crear con plan**. Decisión en design: fallback a `<input>` de texto (read/write) o bloqueo con mensaje. Documentado en design.
- **Test Vitest** nuevo (`InternetPanel.createPlan.test.tsx`) — TDD-first.

### Out of Scope

- **Filtrado del dropdown por "Tipo de IP" (Privada/Pública).** Investigado: **`PlanDto` NO tiene ningún campo público/privado ni variante `-PUB`** (categorías reales: `'Air' | 'Alta' | 'Corte'`; ver `src/types/plans.ts`). El split público/privado del form (`IpType = 'cgnat' | 'public'`, `src/api/nas.api.ts`) gobierna **solo el pool de IP** (`useNextFreeIp`), NO el plan. `SpeedControl` tampoco filtra planes por tipo de IP. **No hay dato sobre el cual filtrar** → el dropdown NO filtra por Tipo de IP. (Si Prominense agrega planes públicos diferenciados en el futuro, es otro change.)
- Cambios de BE (el endpoint `/plans` y `usePlans` ya existen y andan — `SpeedControl` los consume).
- Cambiar el form de **Editar** o `SpeedControl` (ya usan el patrón correcto).
- Mejorar el mensaje genérico del `catch` para el 422 (nice-to-have; el dropdown obligatorio ya previene el 422 por plan vacío).

## Capabilities

### Modified Capabilities
- **PPPoE Management (FE)**: el form "Cargar PPPoE" exige elegir un plan real de un dropdown en vez de tipear un perfil libre opcional.

## Approach

1. **(test primero)** `InternetPanel.createPlan.test.tsx`: el form Crear muestra un `<select>` de planes filtrados; "Crear PPPoE" deshabilitado sin plan; al elegir + completar usuario/pass/router se habilita; submit llama `create.mutateAsync` con `profile: <plan.code>`; degradación si `usePlans` vacío/error.
2. **(green)** Editar `CreatePppoeForm`: `usePlans()`, `eligiblePlans`, swap `<input>`→`<select>`, ajustar `disabled` del botón y el submit, degradación graceful.
3. **(refactor)** Reusar el patrón/label de `SpeedControl` sin duplicar lógica innecesaria; checklist a11y (`ui-ux-pro-max`).

## Affected Areas

| Área | Impacto |
|------|---------|
| **FE** `src/pages/customers/tabs/contracts/InternetPanel.tsx` (`CreatePppoeForm`) | Modified — `<input>` Perfil → `<select>` plan obligatorio + validación + degradación |
| **FE** `src/pages/.../InternetPanel.module.css` | Sin cambio esperado — reusa `.select`, `.field`, `.fieldLabel` existentes |
| **FE** `src/__tests__/contracts/InternetPanel.createPlan.test.tsx` | New — tests TDD del dropdown obligatorio |

Sin tocar: `usePlans`, `plans.api`, tipos `PlanDto`, hooks de PPPoE, BE.

## Risks

| Riesgo | Prob. | Mitigación |
|--------|-------|------------|
| Romper algún test existente de `CreatePppoeForm` que dependa de `#pppoe-profile` (input) | Baja | No hay test que toque el input Perfil de Crear (verificado: los tests de InternetPanel cubren speedControl/enforce/editPolish/adopt/etc., ninguno el Perfil de Crear). Igual: correr toda la suite. |
| Degradación: si los planes no cargan, el operador no puede crear (plan obligatorio) | Media | Espejar `SpeedControl`: fallback a `<input>` texto write-enabled cuando `isError`/vacío, para no bloquear la operación en una caída del endpoint. Decisión en design. |
| Confusión: "Perfil" vs "Plan"/"Velocidad" en el label | Baja | Usar el label/format de `SpeedControl` (`name — rateLimit`) para consistencia. |

## Rollback

Aditivo y localizado a un sub-componente. Rollback = `git revert` del commit FE. Sin cambio de contrato BE ni de schema.

## Dependencies

- `usePlans()` (`src/hooks/usePlans.ts`) + `GET /plans` (`src/api/plans.api.ts`) — ya existen, los usa `SpeedControl`.
- Tipo `PlanDto` (`src/types/plans.ts`) — sin cambio.
- Skill `ui-ux-pro-max` para el `<select>` (touch 44px, focus visible, contraste).

## Success Criteria

- [ ] El form "Cargar PPPoE" muestra un `<select>` de planes (filtrados `enabled` + no-`Corte`), con placeholder "Elegí un plan…".
- [ ] `<option value>` = `plan.code`; el submit manda `profile: <code>` (no el nombre).
- [ ] "Crear PPPoE" deshabilitado hasta elegir plan (además de usuario/pass/router).
- [ ] Degradación graceful si `usePlans` falla/vacío (espejo de `SpeedControl`).
- [ ] Test Vitest nuevo verde; suite existente de InternetPanel sin regresiones; typecheck limpio.
- [ ] Checklist a11y `ui-ux-pro-max` aplicado al select.
