---
name: Extraction diff signal (in-memory only, no storage)
description: Fields promoted to Yes in the most-recent extraction get a persistent "NEW" visual treatment during the current page view, but state must NOT persist across page refresh. Use React context at the app root for cross-page sharing, never localStorage.
type: feedback
---

The 1.5s green flash on promotion is not enough — newly-promoted Yes fields need a persistent visual treatment (subtle green tint + thin accent left border + "NEW" badge next to the field ID) to preserve the diff signal between "confirmed by this call" and "confirmed by a prior call." BUT the merged extraction state must live only in React state, not in localStorage, sessionStorage, or any other browser persistence. Page refresh must reset to the seed baseline on every load. Navigation between pages in the same session (extract → prepare) can preserve state via a React context mounted at the app root.

**Why:** The user needs to be able to re-run the demo from a clean state every time they load the page, without dev-tools intervention. A persistence layer (even scoped to sessionStorage) breaks that workflow. Context persists across Next.js client-side navigation but resets on full page refresh — that's exactly the desired shape.

**How to apply:** Any merged extraction state on the extract page lives in local `useState` only. On successful extract, write to a context provider (e.g., `DemoStateProvider` at app/layout.tsx) so the prepare page can read it when navigated to. The extract page does not *read* from context on mount — it always starts at seed baseline. The prepare page reads context on mount, falling back to seed if empty. If you're tempted to add localStorage to make state survive F5, don't — the user explicitly rejected that as a demo blocker.
