# Change: node-task-type-label (#52)

## Why
The node-task badge shown across the scheduling UI reads "RED" / "Nodo RED". Product wants the user-facing label to read **"Nodo Fibra"** to match the business vocabulary. Purely cosmetic; no behavior change.

## What changes
- Rename the visible badge text "RED" / "Nodo RED" → "Nodo Fibra" in the tasks table, kanban card, and the create-task modal locked-mode badge.
- Keep all `data-testid`, `aria-label` semantics (only human-visible text + the locked-badge aria-label string change).
- No dropdown. The `NodeSelector` "Nodo" wording (site-type label) is OUT of scope.

## Scope
- FRONTEND only. No BE, no API, no DB.

## Non-goals
- No change to task kind logic, NodeSelector, or any dispatch behavior.
