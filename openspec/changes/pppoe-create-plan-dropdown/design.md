# Design: Dropdown de planes (obligatorio) en "Cargar PPPoE"

## Context

El form **`CreatePppoeForm`** (`InternetPanel.tsx`, líneas ~228-480) tiene el campo Perfil como **texto libre opcional**:

```tsx
// estado (línea 239-245)
const [form, setForm] = useState({ username: '', password: '', nasId: '', profile: '', remoteAddress: '' });

// render (línea 374-386)
<label htmlFor="pppoe-profile">Perfil</label>
<input id="pppoe-profile" value={form.profile}
  onChange={(e) => setForm((f) => ({ ...f, profile: e.target.value }))}
  placeholder="Opcional" />

// submit (línea 296-302)
await create.mutateAsync({
  username: form.username.trim(),
  password: form.password,
  nasId: form.nasId,
  profile: form.profile.trim() || undefined,   // ← OPCIONAL
  remoteAddress: form.remoteAddress.trim() || undefined,
});

// botón Crear (línea 464-475) — disabled NO chequea profile
disabled={create.isPending || !form.username.trim() || !form.password || !form.nasId}
```

El orchestrator de PPPoE exige `plan` obligatorio (`min_length=1`) → crear sin plan = **422** → el FE muestra el genérico de `else` (línea 312). El patrón correcto YA está en el mismo archivo, en `SpeedControl`. Lo reusamos.

## El patrón a reusar (`SpeedControl`, líneas ~503-555, 575-587)

```tsx
const plansQuery = usePlans();
const allPlans = plansQuery.data ?? [];
const eligiblePlans = allPlans.filter(
  (p) => p.status === 'enabled' && p.category !== 'Corte',
);
// ...
<select value={selected} onChange={...}>
  {eligiblePlans.map((plan) => (
    <option key={plan.id} value={plan.code}>
      {plan.name ? `${plan.name} — ${plan.rateLimit}` : `${plan.code} — ${plan.rateLimit}`}
    </option>
  ))}
</select>
// Degradación (línea 543):
if (plansQuery.isError || eligiblePlans.length === 0) { /* read-only text */ }
```

Hechos confirmados en el código:
- `PlanDto` (`src/types/plans.ts`): `{ id, code, name, category: 'Air'|'Alta'|'Corte', downloadKbps, uploadKbps, rateLimit, status, createdAt }`. **NO existe campo público/privado ni variante `-PUB`.**
- `<option value>` = **`plan.code`** (ej. `IP-Air-30-30`), nunca el nombre.
- `CreatePppoeBody.profile?: string` (`src/api/pppoe.api.ts`): el `profile` que mandamos ES el `plan.code`.
- El form de Crear ya vive dentro de `<Can permission="pppoe.manage">` (InternetPanel línea 92), igual que `SpeedControl`.

## Decisión 1 — `<input>` Perfil → `<select>` plan OBLIGATORIO

Reemplazar el bloque del `<input id="pppoe-profile">` por un `<select id="pppoe-profile">` (mantener el `id` para no romper labels/estilos; el label pasa de "Perfil" a **"Plan"** o **"Plan / Velocidad"** con marcador `*` de requerido, espejando el `<select>` de Router).

```tsx
const plansQuery = usePlans();
const eligiblePlans = (plansQuery.data ?? []).filter(
  (p) => p.status === 'enabled' && p.category !== 'Corte',
);
// ...
<label htmlFor="pppoe-profile">Plan <span aria-hidden="true">*</span></label>
<select id="pppoe-profile" className={styles.select}
  value={form.profile}
  onChange={(e) => setForm((f) => ({ ...f, profile: e.target.value }))}
  required disabled={create.isPending}>
  <option value="">Elegí un plan…</option>
  {eligiblePlans.map((plan) => (
    <option key={plan.id} value={plan.code}>
      {plan.name ? `${plan.name} — ${plan.rateLimit}` : `${plan.code} — ${plan.rateLimit}`}
    </option>
  ))}
</select>
```

- Label de la option = `name — rateLimit` (o `code — rateLimit` sin nombre): **idéntico a `SpeedControl`** → consistencia visual.
- value = `plan.code` → el submit manda el code. **Confirmado**: lo que viaja en `profile` es el `code`, que es lo que el orchestrator espera como `plan`.

## Decisión 2 — Validación obligatoria (doble capa)

1. **Atributo `required`** en el `<select>` (HTML nativo).
2. **Botón gateado**: sumar `!form.profile` a la condición `disabled` del botón "Crear PPPoE":

```tsx
disabled={
  create.isPending ||
  !form.username.trim() ||
  !form.password ||
  !form.nasId ||
  !form.profile          // ← NUEVO: sin plan no se puede crear
}
```

3. **Submit**: el `profile` ya es requerido, así que se manda directo (no `|| undefined`):

```tsx
profile: form.profile,   // antes: form.profile.trim() || undefined
```

Con esto el 422-por-plan-vacío del orchestrator **deja de poder ocurrir** desde el FE. El usuario nunca ve el genérico por esta causa.

## Decisión 3 — Default del estado `form`

El campo `profile: ''` en el `useState` inicial (línea 243) **se conserva** (`''` = "ningún plan elegido" = la option placeholder). Tras un create exitoso, el reset (línea 304) ya vuelve `profile: ''`. **No hace falta cambiar el default**; el cambio es que `''` ahora es un estado **inválido** que bloquea el submit (antes era válido → se mandaba `undefined`).

## Decisión 4 — Degradación graceful (espejo de `SpeedControl`)

Si `plansQuery.isError || eligiblePlans.length === 0`, el plan obligatorio se vuelve imposible de cumplir con un dropdown vacío → **NO podemos dejar al operador sin poder crear** por una caída del endpoint de planes.

**Decisión: fallback a `<input>` de texto LIBRE (write-enabled), con hint.** A diferencia de `SpeedControl` (que es read-only porque ya hay un perfil aplicado y solo se cambia), en **Crear** necesitamos un valor sí o sí. El fallback restaura el `<input id="pppoe-profile">` de texto (el comportamiento PRE-change) para no bloquear la operación, con un `ipHint`/aviso de que no se pudo cargar la lista de planes y hay que tipear el code exacto.

```tsx
const plansUnavailable = plansQuery.isError || eligiblePlans.length === 0;
// ...
{plansUnavailable ? (
  <>
    <label htmlFor="pppoe-profile">Plan <span aria-hidden="true">*</span></label>
    <input id="pppoe-profile" className={styles.input}
      value={form.profile}
      onChange={(e) => setForm((f) => ({ ...f, profile: e.target.value }))}
      required disabled={create.isPending}
      placeholder="Código del plan (ej. IP-Air-30-30)" />
    <span className={styles.ipHintError}>
      No se pudo cargar la lista de planes — escribí el código exacto del plan.
    </span>
  </>
) : (
  <select id="pppoe-profile" /* ...dropdown... */ />
)}
```

En el fallback, `!form.profile` en el `disabled` del botón sigue exigiendo un valor → el plan sigue siendo obligatorio (texto, pero requerido). El submit manda `profile: form.profile.trim()` (trim solo en la rama input).

> Alternativa considerada y descartada: **bloquear** la creación con un banner "No se puede crear sin lista de planes". Descartada porque deja al operador sin salida ante una caída transitoria del endpoint, y el flujo PRE-change permitía tipear el perfil. El fallback a input preserva esa capacidad de degradación.

## Decisión 5 — Tipo de IP NO filtra el dropdown

**Confirmado en código**: no hay campo de plan que distinga público/privado. `IpType = 'cgnat' | 'public'` (`src/api/nas.api.ts`) afecta **solo** `useNextFreeIp` (el pool de IP), no el plan. `SpeedControl` no filtra planes por IP type. **El dropdown lista TODOS los `eligiblePlans` sin filtrar por el toggle Privada/Pública.** El toggle y el dropdown son ortogonales (uno = pool de IP, otro = velocidad). Documentado como Out of Scope en el proposal.

## A11y (ui-ux-pro-max)

- `<select>` reusa `styles.select` (mismo control que Router/Velocidad → touch target y altura ya consistentes; verificar ≥44px en el CSS existente, no hace falta tocar si ya cumple).
- `<label htmlFor="pppoe-profile">` asociado (ya está) + marcador `*` con `aria-hidden` como el resto de los requeridos.
- `:focus-visible` y `cursor: pointer`: heredados de `.select` (mismo control que ya pasa el checklist en Router/SpeedControl).
- Contraste del placeholder "Elegí un plan…": usar la option estándar (igual que "Elegí un router…", que ya cumple).
- El botón deshabilitado sin plan comunica el estado; el `required` da el mensaje nativo del navegador como respaldo.

## Test Strategy (TDD, Vitest)

Nuevo archivo `src/__tests__/contracts/InternetPanel.createPlan.test.tsx`, mockeando igual que `InternetPanel.speedControl.test.tsx` (`vi.mock('@/hooks/usePlans')`, `usePppoe`, `useNas`, `useMyPermissions`, `useContractServices`). Para llegar al form de Crear: `useContractPppoe` debe devolver **lista vacía** (sin activo) → el panel renderiza `CreatePppoeForm` dentro del `<Can pppoe.manage>`; abrir la `CollapsibleSection "Cargar PPPoE"`.

Casos:
- **CP-1**: con planes → el form Crear muestra un `<select>` con opciones filtradas (`enabled` + no-`Corte`); excluye `Corte` y `disabled`.
- **CP-2**: las `<option>` tienen `value = plan.code` y label `name — rateLimit`.
- **CP-3**: "Crear PPPoE" deshabilitado mientras no haya plan elegido (aun con usuario/pass/router completos).
- **CP-4**: elegir plan + completar usuario/pass/router → "Crear PPPoE" habilitado.
- **CP-5**: submit → `create.mutateAsync` recibe `profile: '<plan.code>'` (el code, NO el nombre).
- **CP-6**: `usePlans` vacío → fallback a `<input>` de texto (degradación), el form sigue creando con el code tipeado; o (según impl) el control sigue exigiendo plan.
- **CP-7**: `usePlans` isError → fallback sin crash (panel/form sigue vivo).
- **CP-8 (regresión)**: el `<select>` de Router y el toggle Tipo de IP siguen presentes y funcionando.

## Out of Scope (recordatorio)

- Filtrado por Tipo de IP (no hay dato). Mejorar el copy del genérico 422. Tocar Editar/`SpeedControl`. Cambios de BE.
