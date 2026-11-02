# Building the PrivacyNotes extension from source

The extension is one package of a pnpm workspace. It is built with WXT and Vite, and it imports two sibling packages (`packages/shared`, `packages/clipper`) and a few files of `packages/web/src`. The source archive carries exactly those.

Requirements: Node 22 or later and pnpm 9 or later.

```
pnpm install --frozen-lockfile
pnpm --filter @notes/shared build
pnpm --filter extension build:firefox
```

The built extension is in `packages/extension/.output/firefox-mv3/`. `pnpm --filter extension build:chrome` and `build:edge` build the other targets.
