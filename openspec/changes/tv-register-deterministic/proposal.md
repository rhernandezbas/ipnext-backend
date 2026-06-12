<!-- generated from engram topic_key: sdd/tv-register-deterministic/proposal -->
## Intent
Nuevo formato de alta de TV (#65), apilado sobre #64. Al registrar una cuenta Gigared:
1. **Email/password determinísticos** derivados del cliente GR — `email = {apellido}{idGR}@gmail.com`,
   `password = "ip{idGR}"` paddeado con `0` al final hasta min 8 chars. Ambos cumplen la política CUA
   [a-z0-9] (verificada live #47h).
2. El form se **prefillea** con ese email + password (editables). El checkbox "Enviar email de activación"
   queda **SIEMPRE inactivo por default** (correo ficticio — no se envía).
3. La clave generada queda **impactada y visible** en el panel del servicio TV (login + contraseña con
   toggle mostrar/ocultar), persistida en el `ContractService` TV.
4. El panel expone **"Cambiar contraseña"** → `PATCH /accounts/{cic} {password}` (guard `tv.register`).
5. El panel muestra el **Login = `GIGA{abonado}`**, donde `abonado` se obtiene de la API por CIC
   (`crm.gigared_id`, formato `GIGA{abonado}` ya presente en `ott.id`).

## Why
Pedido textual del usuario (4 partes):
1. "vamos a generar correos ficticios → apellido + Id usuario (GR) … y la contra sería ip{idGR}; si le
   falta a la contra un caracter ponle un 0 de más ya que serían 8 mínimo."
2. "Deja impactada la clave generada en el servicio de TV."
3. "Investiga en la API si se puede cambiar la contraseña; si se puede, en el modal de servicio TV deja la opción."
4. "El checkbox de enviar email siempre tiene que estar inactivo." + "Tiene que aparecer el Login que sería
   GIGA + abonado; el dato del abonado lo buscás con la API en base al CIC."

## Hallazgos clave (arquitectura)
- El generador #47h (`gigaredPassword.ts`) ya enforce la política CUA [a-z0-9]. Acá agrego helpers
  **determinísticos** puros junto a él, con sus unit tests (autoridad de las reglas en el BE).
- `PATCH /accounts/{cic}` con `{password}` EXISTE en la doc (`tv.md`); `GigaredClient.patch()` ya se usa
  (en `setInternalId`). Se agrega `changePassword(cic, password)` al port + adapter.
- El vínculo Client↔CIC vive en Gigared (`internal_id == customerId`). El único dato TV LOCAL es el
  `ContractService` TV (ownership por notes-prefix `'CIC '`). Las credenciales se persisten en **campos
  nuevos aditivos** `tvLogin`/`tvPassword` en `ContractService` — NO se tocan las notes (el reconcile
  matchea por prefix).
- El audit middleware (`maskSensitive`) ya enmascara `password`. El campo persistido se llama `tvPassword`
  → se agrega a `SENSITIVE_KEYS` para que el `PATCH` del cambio de contraseña no quede en claro.
- `abonado`/login `GIGA{abonado}`: `account.gigaredId` (= `crm.gigared_id`) y/o `account.ott.id`
  (formato `GIGA{abonado}`). El login se computa `GIGA{gigaredId}` con fallback a `ott.id`.

## Cambio propuesto

### Generador (domain-puro BE + replica FE con test)
- `deterministicTvEmail(lastName, grId)` → `{apellido norm}{grId}@gmail.com`. Apellido: primera palabra,
  minúsculas, sin acentos, ñ→n, solo [a-z]. Si queda vacío → fallback `cliente`.
- `deterministicTvPassword(grId)` → `ip{grId}` paddeada con `0` al FINAL hasta min 8 chars.
- Edge: cliente sin `grClienteId` → degradado: generador crypto #47h + email del cliente (documentado).

### Persistencia (campos nuevos aditivos)
- Migración aditiva `20260707000000_contract_service_tv_credentials`: `tvLogin TEXT NULL`,
  `tvPassword TEXT NULL` en `ContractService`.
- `ContractServiceView` += `tvLogin`/`tvPassword`. Repo port `update`/`add` aceptan y persisten esos campos.
  Prisma + InMemory en paridad.
- Punto de persistencia: **`RegisterGigaredAccount`** recibe `contractId` opcional + `tvPassword`; tras
  `setInternalId`, computa `tvLogin = GIGA{gigaredId}` (del account leído) y hace upsert del slot TV
  reusando `reconcileTvContractService` + `update` de credenciales. Si no hay `contractId`, register
  legacy (no persiste). Robusto: el register es el único momento donde la password está en claro.

### Cambio de contraseña
- Port `GigaredPort.changePassword(cic, password)` + `GigaredClient` (`PATCH /accounts/{cic} {password}`).
- Use case `ChangeTvPassword(customerId, contractId, password)`: valida CUA, `PATCH`, persiste `tvPassword`
  en el slot TV. Devuelve la nueva clave para refrescar el panel.
- Route `POST /customers/:id/tv-password` guard `requireRegister` (tv.register). RFC 9457 visible (#47g).

### FE
- `deterministicTv.ts` (replica pura + unit test). El register form prefillea email+password
  determinísticos (editables). Checkbox `sendActivationEmail` default **false**.
- `GigaredPanel` LinkedView: sección "Credenciales Gigared Play" → Login `GIGA{abonado}` + contraseña
  (oculta + toggle) + botón "Cambiar contraseña" → modal (genera otra determinística o manual, validación
  CUA viva) → `useChangeTvPassword`.
- `ContractCard`/`ContractsTab` threadean `grClienteId` al panel.

## Riesgos
- Password en claro persistida en DB (`tvPassword`): es requisito explícito del usuario ("dejar impactada
  la clave visible para el operador"). Mitigación: masking en audit, visible solo con `tv.read`/`tv.register`.
- Cliente sin grClienteId → degradado documentado (no rompe el alta).
- `PATCH /accounts/{cic}` password: documentado en tv.md; si el partner lo rechaza, error RFC 9457 visible.

## Rollback
Quitar migración (drop columns), helpers determinísticos, `changePassword` del port/adapter/use case/route,
y revertir el form FE al prefill #47h. El checkbox vuelve a default true.
