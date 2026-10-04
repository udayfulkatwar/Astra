# F002 — route-based dashboard page loading

Status: done on `claude/frontend-f002-page-loading` (base: F001 head `83de612`).

## Change

- `apps/dashboard/src/App.tsx`: every page except the landing Overview (and Login) is loaded with
  `React.lazy` on first visit. Routes, paths, navigation, auth, query cache and API payloads are
  unchanged.
- `apps/dashboard/src/components/Layout.tsx`: the outlet sits inside `Suspense` (fallback
  "Loading page…") and a boundary keyed by pathname. A chunk that fails to load (offline, or a
  stale tab after a deploy) shows "This page could not be loaded" with a Reload button; the shell
  and menu stay usable, and navigating elsewhere clears the error.
- `apps/dashboard/src/App.test.tsx`: two regressions — a held route import shows the loading
  fallback with the menu usable, then the page; a failed import shows the error, and the menu
  recovers.

## Bundle (production build, `pnpm --filter @astra/dashboard build`)

|                    | Before                     | After                                                      |
| ------------------ | -------------------------- | ---------------------------------------------------------- |
| Entry JS           | 674.79 kB (205.14 kB gzip) | 327.92 kB (102.91 kB gzip)                                 |
| Largest lazy chunk | —                          | Charts 170.32 kB (55.57 kB gzip; holds lightweight-charts) |
| Other lazy chunks  | —                          | 21 page/shared chunks, 0.6–47.9 kB                         |

`index.html` preloads only the entry, runtime and shared `ui` chunk. `lightweight-charts` appears
only in the Charts chunk.

## Limitations

- The demo build keeps one inlined file (`inlineDynamicImports`), so it is not split
  (1273 KB → 1280 KB demo HTML).
- A failed chunk is recovered by a full reload, not an in-place retry (`React.lazy` caches a
  rejected import).
