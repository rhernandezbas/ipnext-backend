# Proposal — actions-worklist (EPIC Titularidad & bajas, F2)

## Intent

Convertir los eventos externos invisibles (cambios de titularidad y bajas en GR) en un
**worklist operativo**: la page "Acciones" del menú, donde cada caso aparece con su checklist
y el operador ve QUÉ falta hacer por cliente. Visión del usuario (2026-07-08): "una subpage
en el menú llamada actions... cambio de titular (los pendientes), otra de bajas (las últimas
bajas)... y tener un check visual para cada action".

Principio rector (validado con el usuario en el esquema): **los checks se AUTO-verifican
contra el estado real donde el sistema puede saberlo; el check manual es SOLO para el mundo
físico.** Un checklist tildeable a mano se convierte en teatro.

F2 del EPIC (F0 spike + F1 transferencia YA en prod). F3 (TV auto-transfer) queda fuera:
acá la TV se transfiere con 1 click DESDE el caso (semi-auto — la escalera acordada).

## What

1. **Detector de cambios de titularidad** (BE): use case nuevo que corre tras cada tick del
   sync GR y escanea el MIRROR (no toca el delta — invariante "execute() intacto" del change
   recapture): contratos `baja` con `motivoBaja` = CAMBIO DE TITULARIDAD sin caso previo →
   pairing determinístico contra contratos activos (claves F0 verificadas: mismo `startDate`
   + mismo `address`, cliente distinto) → crea `OwnershipTransferCase` (idempotente).
   Ambigüedad (≥2 candidatos) → caso `ambiguous` con candidatos para pick manual del operador.
2. **Casos persistidos** con estado (`pending` → `done` | `dismissed`) + check MANUAL
   `equipmentReviewed` (con actor/fecha) + pick de candidato.
3. **Checks AUTO computados en la lectura** (nunca persistidos — no pueden mentir):
   - TV transferida: `tvCancelledAt` del titular viejo + fila TV managed activa en el
     contrato nuevo (señales locales, sin llamar al partner)
   - PPPoE migrado: existe PppoeService `enabled` en el contrato nuevo
   - Equipos: conteo de ítems activos viejo vs nuevo (informativo) + el check manual
4. **Worklist de bajas recientes** (computado, sin tabla): contratos `baja` recientes con el
   check AUTO "orden de retiro creada" = existe ScheduledTask del contrato/cliente cuyo
   proyecto tiene `allowsEquipmentRetirement=true`.
5. **Router `/api/actions`** + módulo RBAC `actions` (read/manage) doble capa + migración de
   seed (patrón grant_recapture_permissions).
6. **FE — page "Acciones"** (`/admin/customers/acciones`, sidebar bajo Clientes): 2 tabs
   (molecules/Tabs), cards de caso con `CaseChecklist` (StatusBadge para AUTO, checkbox para
   manual), acción **"Transferir TV" 1-click** reusando `TransferServiceModal` extendido con
   destino precargado (hereda 207/retry idempotente de F1), descarte con motivo, tab Bajas
   con su check de retiro.

## Decisions

- Detector como use case SEPARADO post-sync (NO hook en el delta) — respeta el invariante y
  es retro-activo (un reset de cursor re-detecta gratis).
- Pairing conservador: match único → caso `pending` pareado; ≥2 candidatos → `ambiguous`
  (pick manual); 0 candidatos → caso igual (visible, sin destino — puede resolverse después).
- El 1-click compone el endpoint F1 existente (`POST /transfer-tv`, guard `tv:transfer`) —
  cero superficie BE nueva para transferir.
- Bajas: listing computado (sin tabla) — la fuente es el mirror; el retiro-check es AUTO.
- Permisos: `actions:read` (ver la page) / `actions:manage` (tildear manual, pick, descartar).
  El 1-click de TV además exige `tv.transfer` (el guard del endpoint F1 ya lo enforcea).

## Out of scope

- F3 TV auto-transfer (el detector NO dispara transferencias solo).
- Ingest de OS tipo BA de GR (el retiro-check usa la señal local del project flag; si más
  adelante se ingestan retiros, el check se enriquece solo).
- Checks manuales para bajas (solo el AUTO de retiro por ahora).
- Backfill histórico: el detector arranca desde su cursor (bajas nuevas); un reset de cursor
  del sync re-detecta ventanas pasadas si hace falta.

## Risks / flags

- Toca `app.ts` (router + scheduler wiring) → known_debt god-object-app.
- El pairing usa `address` string-exacto (F0: idéntico contrato-a-contrato) — un typo de GR
  produce caso sin candidato (aceptable: visible igual, pick manual).
- `motivoBaja` es forward-only (sin backfill): casos solo para bajas post 2026-07-10.
