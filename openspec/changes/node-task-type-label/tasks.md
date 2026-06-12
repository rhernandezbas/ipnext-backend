# Tasks: node-task-type-label (#52)

- [x] 1. Test: KanbanCard kind=network without networkSiteName renders badge "Nodo Fibra".
- [x] 2. Test: TasksTableView kind=network renders badge "Nodo Fibra".
- [x] 3. Test: locked-mode CreateTaskModal badge text + aria-label "Nodo Fibra".
- [x] 4. Rename badge text in TasksTableView.tsx (RED → Nodo Fibra).
- [x] 5. Rename fallback in KanbanCard.tsx ('RED' → 'Nodo Fibra').
- [x] 6. Rename badge text + aria-label in CreateTaskModal.tsx (Nodo RED → Nodo Fibra).
- [x] 7. Sweep SchedulingTaskDetailPage / TasksPageBase — no other badge text found.
- [x] 8. Green: targeted suites + full scheduling suite (627 tests) + tsc --noEmit clean.

Result: committed 0bfba76 on feat/52-node-fibra-label (FE worktree).
