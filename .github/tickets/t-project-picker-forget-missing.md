**Importance:** Quick win · **Size:** S · **Depends on:** nothing. Found during the T9 UX review; not part of T9.

**Why.** On a developer machine the project picker shows 658 entries, 590 of which point at deleted
Playwright temp folders, each with its own "Forget" button, plus an error toast on load because the
last-opened path is gone. A new user's first screen should not be a list of other people's garbage.

**Scope.**
- [ ] "Forget all missing" button that removes every entry whose folder no longer exists, after a
      confirm that states the count.
- [ ] No error toast when the remembered last-opened path is missing; show the picker quietly.
- [ ] Missing entries visually distinct (muted) before they are forgotten.

**Not in scope.** Changing how projects are remembered (`~/.cht-ui-builder/state.json` format).

**Acceptance.**
1. With 10 remembered paths of which 6 are deleted, "Forget all missing" removes exactly 6 and
   `state.json` lists the remaining 4.
2. Starting the app with a missing last-opened path shows the picker with no toast.

**Validate.**
```sh
pnpm typecheck && pnpm lint
pnpm --filter @cht-ui/client test:e2e
```
