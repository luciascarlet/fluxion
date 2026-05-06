# Fluxion

A basic offline Electron app shell with React, Vite, and TypeScript.

## Scripts

- `bun install` installs dependencies.
- `bun run electron:dev` starts the local React dev server and opens Electron.
- `bun run build` builds the renderer and Electron main process.
- `bun run start` opens the built offline app with Electron.

The app does not depend on remote runtime assets. Production Electron loads `dist/index.html` from disk.
