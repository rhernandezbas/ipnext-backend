# Design — tv-reactivation-sequential (#81)

## Modelo del seq (dónde vive, cómo se incrementa)

La identidad de TV es **por cliente**, no por contrato. Los N contratos de un cliente comparten una sola cuenta de TV en el partner, así que el contador, el internal_id vigente y el mail vigente viven a nivel `Client`.

- Campo aditivo `Client.tvActivationSeq Int @default(0)`.
- `seq = 0` ⟺ identidad de hoy (internal_id = `Client.id` crudo, mail sin sufijo). Es el estado de TODOS los clientes existentes y el de toda alta nueva.
- El seq se incrementa **SOLO en re-alta**: cuando `RegisterGigaredAccount` corre sobre un cliente que venía de baja (`tvCancellation.isCancelled(clientId) === true`). Esa es la única señal honesta de "esta es una reactivación, no la primera alta".

## Helper de identidad (dominio puro)

`src/domain/gigared/tvIdentity.ts`:

```ts
export function currentTvInternalId(clientId: string, seq: number): string {
  return seq <= 0 ? clientId : `${clientId}-${seq}`;
}
```

Sin dependencias. seq<=0 devuelve el id pelado → back-compat total.

## Email determinístico secuencial (#65)

`deterministicTvEmail(lastName, grId, seq = 0)`:
- `seq <= 0` → `{apellido}{grId}@gmail.com` (el de hoy, default param → todos los callers viejos siguen compilando).
- `seq > 0` → `{apellido}{grId}{seq}@gmail.com`.

Determinístico + recuperable: el operador lo ve en Credenciales (#65).

## El seam (cómo se resuelve el internal_id vigente)

Cada use case ya hace `customerLookup.findById(customerId)` temprano. Extendemos `CustomerLookup` para que devuelva `tvActivationSeq?: number | null` (opcional, mirror de cómo se agregó `grClienteId` en #70 — los callers viejos siguen compilando y caen a `seq=0`).

Luego cada use case computa una sola vez:
```ts
const internalId = currentTvInternalId(customerId, customer.tvActivationSeq ?? 0);
```
y usa `internalId` en TODA llamada al port donde antes pasaba `customerId`:
- `GetGigaredCustomerAccount` → `getAccountByInternalId(internalId)`
- `CancelTv` → `getAccountByInternalId`, `removeService`, `setOtt`, `renewCic`, reconcile
- `ChangeTvPassword` → `getAccountByInternalId`
- `AddTvService` / `RemoveTvService` → `addService` / `removeService` / `getAccountByInternalId` + reconcile
- `SetOttStatus` → `setOtt`
- `LinkCustomerToCic` → `setInternalId(cic, internalId)` + `getAccountByInternalId(internalId)`

`reconcileTvContractService` gana un param opcional `internalId` (default = `customerId`) para leer la cuenta vigente sin romper a los callers que no lo pasan.

Con `seq=0` el `internalId` es idéntico a `customerId` → comportamiento byte-for-byte de hoy. Los tests existentes que asertan `setInternalId('...','cust-1')` y `getAccountByInternalId('cust-1')` siguen verdes.

## RegisterGigaredAccount — minteo de identidad fresca

Inyectamos un port opcional `ClientTvActivationRepository`:
```ts
interface ClientTvActivationRepository {
  getSeq(clientId: string): Promise<number>;
  incrementSeq(clientId: string): Promise<number>; // atómico, devuelve el NUEVO seq
}
```

Flujo en `execute`:
1. Resolver el seq A USAR:
   - Si el cliente venía de baja (`tvCancellation?.isCancelled` true) y hay `activation` repo → `seq = await activation.incrementSeq(clientId)` (re-alta → 1, 2, 3…).
   - Si no → `seq = customer.tvActivationSeq ?? 0` (primera alta → 0, back-compat).
2. `internalId = currentTvInternalId(clientId, seq)`.
3. `email = seq > 0 ? deterministicTvEmail(lastName, grClienteId, seq) : input.email` (en re-alta el mail lo genera el server con el seq; en alta normal respeta el que mandó el FE → back-compat).
4. `register/activate` con ese email, `setInternalId(cic, internalId)`, `getAccountByInternalId(internalId)`.

Nunca reusa el id viejo: en re-alta el internal_id lleva el sufijo `-{seq}`, nunca quemado, y registra sobre el CIC renovado limpio.

## Seam en tests

`fakePort()` se vuelve STATEFUL para el seam: un `Map<internalId, account>` donde `setInternalId` graba y `getAccountByInternalId` lee. Así el fake simula que el id viejo (`cust-1`) está quemado/muerto y el nuevo (`cust-1-1`) registra limpio. `register` real (use case) + repos in-memory (ContractService, ServiceCatalog, ClientTvActivation, ClientTvCancellation).

## Wire contract BE↔FE

- `Client.tvActivationSeq` (int, default 0).
- `CustomerLookup.findById` → `{ id; grClienteId?; tvActivationSeq?: number | null }`.
- Port `ClientTvActivationRepository`.
- Credenciales (#65): el reader/DTO expone `internalId` + `email` vigentes además de `login`/`password`, para que el FE muestre la identidad actual.
