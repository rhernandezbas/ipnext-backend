# Spec: PPPoE Management — "Cargar PPPoE" plan dropdown (Delta)

**Capability**: `pppoe-management` (MODIFIED)
**Change**: `pppoe-create-plan-dropdown`
**Summary**: El form "Cargar PPPoE" (`CreatePppoeForm`) reemplaza el campo Perfil de **texto libre opcional** por un **`<select>` de planes de Prominense, OBLIGATORIO**, reusando el patrón de `SpeedControl`. El value de cada option es el `plan.code`, que viaja como `profile` en `CreatePppoeBody`. La creación se bloquea hasta elegir un plan. Si la lista de planes no carga, degrada a un input de texto requerido.

---

## Overview

Crear un PPPoE exige `plan` no vacío en el orchestrator (`min_length=1`). Un campo de texto libre opcional permite (a) crear sin plan → 422 con mensaje genérico, y (b) tipear un code inexistente. El dropdown obligatorio, poblado de planes reales habilitados, elimina ambas clases de error. El cambio es FE-puro: el endpoint `GET /plans` y `usePlans()` ya existen y los consume `SpeedControl`.

---

## 1. Dropdown de planes

### REQ-CP-1: El campo Perfil es un `<select>` de planes, no un input de texto

El sub-componente `CreatePppoeForm` (`InternetPanel.tsx`) MUST renderizar un `<select id="pppoe-profile">` poblado con los planes de `usePlans()`, filtrados por `status === 'enabled' && category !== 'Corte'` (misma regla que `eligiblePlans` de `SpeedControl`). El `<select>` MUST llevar una option placeholder con `value=""` y texto tipo "Elegí un plan…". El label asociado MUST marcar el campo como requerido (marcador `*`).

#### Scenario: El form de Crear muestra solo planes habilitados y no-Corte

**Given** `usePlans()` devuelve planes `[Air 10/5 (enabled), Air 30/10 (enabled), Corte (category=Corte), Alta (status=disabled)]`
**And** el contrato no tiene PPPoE activo (se renderiza `CreatePppoeForm`)
**And** la sección "Cargar PPPoE" está expandida
**When** se inspecciona el control de plan
**Then** existe un `<select>` (role combobox) en el form de Crear
**And** muestra las options "Air 10/5" y "Air 30/10"
**And** NO muestra el plan de category `Corte` ni el plan `disabled`

### REQ-CP-2: El value de cada option es el `plan.code`; el label es `name — rateLimit`

Cada `<option>` MUST tener `value={plan.code}` y `key={plan.id}`. El texto visible MUST ser `` `${plan.name} — ${plan.rateLimit}` `` cuando hay `name`, o `` `${plan.code} — ${plan.rateLimit}` `` si no — idéntico a `SpeedControl`.

#### Scenario: El submit envía el code del plan, no el nombre

**Given** el operador eligió el plan con `code: "IP-Air-30-10"`, `name: "Air 30/10"`
**And** completó usuario, contraseña y router
**When** hace click en "Crear PPPoE"
**Then** `useCreatePppoe().mutateAsync` se llama con `profile: "IP-Air-30-10"` (el code)
**And** NUNCA con el nombre del plan ("Air 30/10")

---

## 2. Validación obligatoria

### REQ-CP-3: "Crear PPPoE" está deshabilitado hasta elegir un plan

El botón "Crear PPPoE" MUST estar deshabilitado mientras `form.profile` sea vacío (`""`), además de las condiciones existentes (usuario, contraseña, router, `create.isPending`). El `<select>` MUST llevar el atributo `required`.

#### Scenario: Sin plan elegido el botón está deshabilitado

**Given** usuario, contraseña y router están completos
**And** el `<select>` de plan está en la option placeholder (`value=""`)
**When** se inspecciona el botón "Crear PPPoE"
**Then** el botón está deshabilitado

#### Scenario: Elegir un plan habilita el botón

**Given** usuario, contraseña y router están completos
**When** el operador elige un plan del `<select>`
**Then** el botón "Crear PPPoE" se habilita

### REQ-CP-4: El profile viaja requerido en el submit

El handler de submit MUST mandar `profile: form.profile` (valor del code elegido) sin convertirlo a `undefined`. El path de "perfil vacío → 422 genérico" deja de ser alcanzable desde el FE.

---

## 3. Degradación graceful

### REQ-CP-5: Si los planes no cargan, el campo degrada a input de texto requerido

Si `plansQuery.isError` OR `eligiblePlans.length === 0`, `CreatePppoeForm` MUST NO renderizar un `<select>` vacío que impida crear. En su lugar MUST renderizar un `<input type="text" id="pppoe-profile">` requerido (restaurando el comportamiento previo) con un hint visible de que la lista de planes no cargó y hay que escribir el código exacto del plan. El plan SIGUE siendo obligatorio (el botón "Crear PPPoE" permanece deshabilitado hasta que el input tenga valor). El form NO debe crashear.

> Razón de la decisión (no read-only como `SpeedControl`): en Crear el valor es indispensable; bloquear dejaría al operador sin salida ante una caída transitoria del endpoint de planes. El fallback preserva la capacidad de carga manual que existía antes del change.

#### Scenario: usePlans vacío → fallback a input de texto, sin crash

**Given** `usePlans()` devuelve `[]` (o `eligiblePlans` queda vacío)
**And** el contrato no tiene PPPoE activo
**When** se renderiza el form "Cargar PPPoE"
**Then** NO hay un `<select>` de plan
**And** hay un `<input>` de texto para el código de plan, con un hint de que la lista no cargó
**And** el form sigue presente y funcional (no crashea)

#### Scenario: usePlans con error → fallback sin crash

**Given** `usePlans()` está en estado `isError`
**When** se renderiza el form "Cargar PPPoE"
**Then** el form sigue presente (no pantalla en blanco)
**And** el operador puede cargar el código de plan a mano

---

## 4. Sin filtrado por Tipo de IP

### REQ-CP-6: El dropdown NO filtra por el toggle Privada/Pública

El `<select>` de plan MUST listar TODOS los `eligiblePlans` independientemente del valor del toggle "Tipo de IP" (`ipType: 'cgnat' | 'public'`). `PlanDto` no tiene ningún campo público/privado ni variante `-PUB`; el toggle gobierna solo el pool de IP (`useNextFreeIp`), que es ortogonal al plan.

#### Scenario: Cambiar el Tipo de IP no altera las opciones de plan

**Given** el `<select>` de plan muestra N options
**When** el operador alterna el toggle Tipo de IP entre Privada y Pública
**Then** el `<select>` de plan sigue mostrando las mismas N options (sin filtrar)

---

## 5. No-regresión

### REQ-CP-7: El resto del form de Crear sigue intacto

El `<select>` de Router, los campos Usuario / Contraseña / IP remota, el toggle Tipo de IP y la auto-asignación de IP MUST seguir funcionando como antes. El cambio se limita al control de plan.

#### Scenario: Router y Tipo de IP siguen presentes

**Given** el form "Cargar PPPoE" renderizado con planes disponibles
**When** se inspecciona el form
**Then** el `<select>` de Router está presente
**And** el toggle Tipo de IP (Privada/Pública) está presente y operable

---

## Appendix: Contratos

| Elemento | Valor |
|----------|-------|
| Filtro de planes | `status === 'enabled' && category !== 'Corte'` |
| `<option value>` | `plan.code` |
| `<option>` label | `name — rateLimit` (o `code — rateLimit`) |
| Campo que viaja al BE | `CreatePppoeBody.profile` = `plan.code` |
| Placeholder option | `value=""`, texto "Elegí un plan…" |
| Degradación | `<input>` texto requerido + hint si `isError`/vacío |
| Filtro por Tipo de IP | NO (no hay dato en `PlanDto`) |
