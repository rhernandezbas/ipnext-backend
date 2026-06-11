# Archive Report: nodes-city-mapper (#45)

**Change**: `nodes-city-mapper` (#45)  
**Status**: SHIPPED  
**Archived**: 2026-06-11  
**BE PR**: #109  
**FE PR**: #84  

## Summary

City mapper integration for NetworkSites via IClass node catalog. Nodes ARE cities; manual sync + admin catalog + validated assignment to network sites. FE select widget with sync button.

## Implementation & Verification Status

### Backend (PR #109)

**Gates**: 3459 checks passed / 0 failures + tsc clean  
**Changes**:
- Added `IClassNode` entity (Prisma)
- Implemented `SyncIClassNodesUseCase` with upsert logic
- GET `admin/iclass/nodes` with filters (active, selectable)
- PUT `network-sites/:id` with atomic city sync
- IClassPort enhanced with `nodeId` descriptor
- Error types: `IClassUnavailable`, `IClassNodeNotFound`, `IClassNodeNotAssignable`

**Key Facts**:
- `nodeId` is an integer (English field from IClass, non-translatable)
- Code groupers ("IPNEXT INTERNET", "Main", "Argentina") persisted as `selectable=false`
- Null `iclassNodeId` on PUT clears only the node reference, preserves `city`
- Backward compat: legacy `iclassNodeCode` free-text assignments still work without validation

**Review Loop**: 1 CRITICAL false positive (nodeId field — refuted with live API evidence showing nodeId as integer field on the adapter), H1 (city desync via PUT — acknowledged, documented in REQ-NCAT-3), M1 (inactive assigned node UI state — fixed in FE), M2 (async GET without error path — fixed) → CLEAN

### Frontend (PR #84)

**Gates**: 2482 checks passed / 0 failures + typecheck clean  
**Changes**:
- `UispNodeMappingBody`: select widget for IClass nodes
- Filters: `active && selectable` nodes
- Legacy unmapped codes shown as disabled option "{code} (sin validar)"
- "Sincronizar desde IClass" button with result toast
- Query invalidation on node change
- Permissions: gated by `uisp.read`, route under `network.read`

**Verified**: gates and permissions match existing implementation

## Post-Deploy User Action

User must manually click **"Sincronizar desde IClass"** to fetch and persist the node catalog. This is intentional to avoid automatic sync on first deploy. After sync, sites can be mapped to cities via the select widget.

## Specs Synced

| Domain | Status | Details |
|--------|--------|---------|
| `iclass-node-catalog` | Created | New spec at `openspec/specs/iclass-node-catalog/spec.md` — 5 requirements (sync, list, assignment, port descriptor, FE select) |

## Archive Contents

- `proposal.md` ✅ — scope, approach, manual vs auto sync decision
- `explore.md` ✅ — investigation of node structure, city mapping concepts
- `design.md` ✅ — architecture, entity, port design, error handling
- `tasks.md` ✅ — 14 tasks, all completed
- `specs/iclass-node-catalog/spec.md` ✅ — requirements, scenarios, wire shapes

## Source of Truth Updated

- `openspec/specs/iclass-node-catalog/spec.md` — new capability spec

## SDD Cycle Complete

Change fully planned (proposal + design + spec), implemented (BE + FE), verified (gates + review), and archived. Ready for next change.

## Observation IDs (for engram cross-reference)

*None — artifact store mode is openspec (filesystem-based).*
