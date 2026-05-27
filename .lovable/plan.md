## What's happening

Projects in this app live only in the browser (localStorage + IndexedDB + a `window.name` backup). When the preview reloads on `/editor/:projectId` in a context where that storage doesn't have the project (different host, cleared storage, fresh preview window, etc.), `useProject` resolves with `project === undefined` and the route renders the **"Project not found. Back to dashboard"** screen. That's the dead-end you keep landing on whenever the preview restores its last URL.

## Fix (quick UX fix)

Make the editor route never strand the user on a missing-project screen — bounce back to `/` automatically, and make sure `/` always offers a clear way forward.

### Change 1 — `src/routes/editor.$projectId.tsx`
- Remove the "Project not found" fallback JSX.
- When `loaded === true && !project`, call `nav({ to: "/", replace: true })` from a `useEffect` and render the existing "Loading project…" placeholder in the meantime.
- Keep the `loaded === false` loading state unchanged.

Result: any time the editor can't find the project, the URL is rewritten to `/` and the dashboard appears instead of the dead-end screen.

### Change 2 — Defensive routing on root
- In `src/routes/__root.tsx` / router config, confirm `notFoundComponent` redirects/links to `/` (already does via the global fallback). No code change expected unless missing.

### Out of scope (not doing now)
- Recovering the "last opened" project automatically.
- Moving projects to the Lovable Cloud backend so they survive across preview hosts.

Say the word if you'd like either of those as a follow-up.