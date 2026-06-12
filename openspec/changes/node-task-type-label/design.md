# Design: node-task-type-label (#52)

## Decision
The badge is rendered inline (no shared `NetworkBadge` component) at three points. Rename text in place; do not refactor into a shared component (out of scope, would inflate the diff).

## Render points (frontend)
- `src/pages/scheduling/SchedulingTasksPage/components/TasksTableView.tsx` — title-column badge text `RED` → `Nodo Fibra`.
- `src/pages/scheduling/SchedulingTasksPage/components/KanbanCard.tsx` — fallback `task.networkSiteName ?? 'RED'` → `?? 'Nodo Fibra'`.
- `src/pages/scheduling/SchedulingTasksPage/components/CreateTaskModal.tsx` — locked-mode badge text + aria-label `Nodo RED` → `Nodo Fibra`.

## Wire contract
None — no data crosses the wire. `data-testid="network-badge"` and `aria-label="Tarea de red"` are unchanged (test stability).

## Test impact
`NetworkBadge.test.tsx` keys off `data-testid` (safe). One fallback assertion `/Nodo Central|RED/i` updated to `/Nodo Central|Nodo Fibra/i`. New assertions: badge text "Nodo Fibra" when no site name. Locked-modal badge text/aria assert "Nodo Fibra".

## Back-compat
No persisted data, no API. Label-only.
