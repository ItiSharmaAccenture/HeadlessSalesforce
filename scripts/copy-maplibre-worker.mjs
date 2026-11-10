// Copies MapLibre's web worker into public/ so the browser can load it as a
// static file. Turbopack does not bundle the worker MapLibre resolves via
// import.meta.url. Runs before `dev` and `build` so it tracks the installed version.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(root, 'public', 'vendor', 'maplibre');
mkdirSync(target, { recursive: true });
copyFileSync(join(root, 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl-worker.mjs'), join(target, 'maplibre-gl-worker.mjs'));
