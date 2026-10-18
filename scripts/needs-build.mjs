// Exit code 1 when the app must be (re)built: no build yet, or source files newer than the build.
// Used by the launchers so an updated copy never runs a stale build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputs = ['dist-server/server/index.js', 'dist-web/index.html'].map((p) => path.join(root, p));
if (!outputs.every((p) => fs.existsSync(p))) process.exit(1);
const builtAt = Math.min(...outputs.map((p) => fs.statSync(p).mtimeMs));

function newest(dir) {
  let t = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    t = Math.max(t, e.isDirectory() ? newest(p) : fs.statSync(p).mtimeMs);
  }
  return t;
}
const dirs = ['web', 'server', 'shared'].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));
const files = ['package.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.server.json'].map((f) => path.join(root, f)).filter((f) => fs.existsSync(f));
const src = Math.max(0, ...dirs.map(newest), ...files.map((f) => fs.statSync(f).mtimeMs));
process.exit(src > builtAt ? 1 : 0);
