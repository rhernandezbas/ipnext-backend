<!-- generated from engram topic_key: sdd/tv-register-deterministic/tasks -->
## BE — generador determinístico (domain-puro)
- [x] T1: `deterministicTvEmail` + `deterministicTvPassword` en `gigaredPassword.ts` + unit tests.

## BE — persistencia de credenciales (campos aditivos)
- [x] T2: Migración `20260707000000_contract_service_tv_credentials` + schema.prisma tvLogin/tvPassword.
- [x] T3: `ContractServiceView` + `ContractServiceItem` += tvLogin/tvPassword; port; InMemory paridad.
- [x] T4: PrismaContractServiceRepository + PrismaCustomerRepository mapean los campos.

## BE — register persiste credenciales
- [x] T5: `RegisterGigaredAccount` recibe `{contractId?}`; persiste login GIGA{abonado}+password (best-effort).
- [x] T6: route POST `/register` default sendActivationEmail=false + pasa contractId.

## BE — cambio de contraseña
- [x] T7: port+adapter `changePassword(cic,password)` (PATCH /accounts/{cic} {password}).
- [x] T8: use case `ChangeTvPassword` (valida CUA, ownership, PATCH, persiste tvPassword).
- [x] T9: route POST `/customers/:id/tv-password` guard tv.register; 400 invalid password.
- [x] T10: audit masking += 'tvpassword'.
- [x] T11: wiring app.ts (register con deps + changeTvPassword).

## FE
- [x] T12: `deterministicTv.ts` replica pura + unit test.
- [x] T13: register form prefillea email+password determinísticos; checkbox default FALSE.
- [x] T14: types + api + hook `useChangeTvPassword`; payload register += contractId.
- [x] T15: GigaredPanel LinkedView sección "Credenciales Gigared Play" + modal cambiar contraseña.
- [x] T16: ContractCard/ContractsTab/CustomerDetailPage threadean grClienteId.

## Gates
- [x] BE: tsc 0 errores; 357 tests targeted pass.
- [x] FE: typecheck 0 errores; 183 tests targeted pass (2 fallos cancelTv pre-existentes del #64).
