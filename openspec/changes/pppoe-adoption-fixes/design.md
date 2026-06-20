# Design: PPPoE Adoption Fixes

## Context

3 bugs de prod sobre la adopción de inventario PPPoE. El explore confirmó causa raíz de cada uno (no son suposiciones). Este design fija las decisiones de implementación.

## Decisión 1 — Bug 1: filtrar en el ingest, no solo en la lista

**Problema:** `IngestPppoeFromNas` itera `orchestrator.listUsers()` y persiste todo lo que no exista, sin filtro. Los placeholders `accesosur1..10` (entradas reales del padrón RADIUS) entran como `PppoeService` huérfanos y aparecen en `GET /api/pppoe/unassigned`.

**Decisión:** filtrar en el **ingest** (capa correcta: la basura nunca entra a la DB → no aparece en lista, counts, logs). Patrón **configurable** (no hardcodeado, es ISP-specific): inyectar `exclusionPatterns: RegExp[]` por constructor (default `[]`), resuelto de `config.ts` (`PPPOE_INGEST_EXCLUDE_PATTERN`, default `^accesosur\d+$`). Filtro secundario en `ListUnassignedPppoe` como defensa en profundidad para data ya ingerida (antes de borrar las 10 filas).

**Por qué no solo en la lista:** filtrar solo en `ListUnassignedPppoe` deja la basura en la DB (sale en counts, en cualquier otra lectura). El ingest es la frontera.

**Semántica del resultado:** agregar `excluded` al `IngestResult` (separado de `skipped`=ya existía) para no perder claridad diagnóstica.

```ts
// IngestPppoeFromNas.execute(), dentro del for, antes del findByUsername:
if (this.exclusionPatterns.some((re) => re.test(item.username))) {
  excluded += 1;
  continue;
}
```

## Decisión 2 — Bug 2: corregir el FE, NO el vocabulario del dominio

**Problema:** hay DOS campos de status en `PppoeService`:
- `status`: `'enabled' | 'disabled' | 'pending'` — estado del secret RADIUS/RouterOS.
- `enforcedState`: `'active' | 'reduced' | 'blocked'` — estado de enforcement (corte).

`InternetPanel.tsx` L53 (`find(p => p.status === 'active')`) y L647 (badge) chequean `status === 'active'`, que **nunca** matchea (status es `'enabled'`).

**Decisión:** corregir el **FE** (2 líneas: `'active'` → `'enabled'`). NO tocar el vocabulario del dominio: `status: 'enabled'|'disabled'` es correcto y espeja RouterOS/RADIUS; cambiarlo rompería `UpdatePppoeBodySchema` (`z.enum(['enabled','disabled'])`) y confundiría el significado del campo.

**Confirmado (explore):** ningún otro consumidor FE chequea `pppoeDto.status === 'active'`. Las páginas de enforcement usan `enforcedState`.

## Decisión 3 — Bug 3: nueva fuente de asignaciones desde PppoeService

**Problema:** `GET /api/ip-assignments` → `ListIpAssignments` → `IpAssignment` (tabla **vacía en prod**, documentado en `ListIpNetworks`/`ListIpPools`: la verdad vive en RADIUS/router). La tab muestra "0".

**Decisión:** nuevo use case `ListPppoeAssignments` que lee de `PppoeServiceRepository.findAssigned()` (filas con `contractId != null` AND `remoteAddress != null` AND `status='enabled'` — las asignaciones reales). Reemplaza la impl de `GET /api/ip-assignments` (mismo endpoint, nueva fuente — el explore confirmó que solo la tab lo consume).

**Por qué no `AssignedIpsProvider`:** ese provider devuelve `string[]` (IPs crudas para contar). La tab necesita la binding completa IP→cliente (username, contractId, profile) — eso vive en la entidad `PppoeService`, no en el provider.

**DTO de salida** (consumido por la tab):
```ts
interface PppoeAssignmentDto {
  id: string;            // pppoeService.id
  ip: string;            // remoteAddress
  username: string;      // username (col "Pool" → re-label a "Usuario")
  contractId: string;    // contractId (col "Cliente (ID)")
  profile: string|null;  // profile (col "Plan")
  nasId: string;
  status: string;
  createdAt: string;     // (col "Asignada el")
}
```

**FE:** re-mapear las columnas de la tab Asignaciones en `GestionRedPage.tsx` (IP, Usuario, Contrato, Plan, Estado, Creada) + ajustar el type `IpAssignment` en `types/network.ts`.

## Decisión 4 — Limpieza de las 10 filas placeholder

Post-deploy (ops): borrar las 10 filas `PppoeService` con username `accesosurN` de la DB Prominense. NO tocar el HA/router (los `accesosur1..10` quedan como slots reservados allá). El filtro del ingest evita que se re-agreguen.

## Test Strategy (TDD estricto)

- **BE bug 1**: `IngestPppoeFromNas` con `exclusionPatterns: [/^accesosur\d+$/i]` → excluye `accesosur1`, persiste `juanperez`; `excluded`/`created` correctos.
- **BE bug 3**: `findAssigned()` (in-memory) devuelve solo asignados (contrato+IP), excluye huérfanos y sin-IP; `ListPppoeAssignments` mapea al DTO; seam test ruta→use case→repo in-memory.
- **FE bug 2**: InternetPanel con `status:'enabled'` → muestra panel activo; con `'disabled'` → "Desactivado".
- **FE bug 3**: tab Asignaciones con asignaciones mockeadas → muestra la IP, no "No se encontraron asignaciones".

## Risks recap

Bajo riesgo (bugfixes contenidos). El único cuidado real: confirmar que `GET /api/ip-assignments` solo lo usa la tab (confirmado) antes de cambiar su fuente.
