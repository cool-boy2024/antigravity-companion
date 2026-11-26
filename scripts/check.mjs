import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
for (const folder of ['src', 'web', 'scripts', 'test']) {
  for (const file of await readdir(path.join(root, folder))) {
    if (/\.(?:m?js)$/.test(file)) execFileSync(process.execPath, ['--check', path.join(root, folder, file)], { stdio: 'inherit' });
  }
}
for (const file of ['package.json', 'plugin.json', 'hooks.json', 'data/competitors.json']) JSON.parse(await readFile(path.join(root, file), 'utf8'));
const manifest = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version || manifest.name !== pkg.name) throw new Error('Plugin/package version or name mismatch');
if (Object.keys(pkg.dependencies || {}).length) throw new Error('Unexpected runtime dependency');
console.log('JS syntax, JSON, manifest consistency and zero runtime dependencies: OK');
