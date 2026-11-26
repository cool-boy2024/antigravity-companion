import { lstat, readdir, readFile } from 'node:fs/promises';
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
if (!(await readFile(path.join(root, 'web/index.html'), 'utf8')).includes(`v${pkg.version}`)) throw new Error('Web UI version mismatch');
if (Object.keys(pkg.dependencies || {}).length) throw new Error('Unexpected runtime dependency');
const packageScript = await readFile(path.join(root, 'scripts/package.mjs'), 'utf8');
for (const doc of ['AI_INSTALL.md', 'CLAUDE.md']) {
  if (!pkg.files.includes(doc)) throw new Error(`Missing ${doc} in package.json files`);
  if (!packageScript.includes(`'${doc}'`)) throw new Error(`Missing ${doc} in scripts/package.mjs`);
  if (!(await readFile(path.join(root, doc), 'utf8')).trim()) throw new Error(`Empty required doc: ${doc}`);
}
if (!(await readFile(path.join(root, 'docs/AGENTS.md'), 'utf8')).trim()) throw new Error('Empty required doc: docs/AGENTS.md');
await lstat(path.join(root, 'AGENTS.md')).then(
  () => { throw new Error('Keep AGENTS.md under docs/AGENTS.md so agy plugin validate --strict stays warning-free'); },
  (error) => { if (error.code !== 'ENOENT') throw error; },
);
for (const entry of pkg.files) await lstat(path.join(root, entry));
console.log('JS syntax, JSON, manifest consistency, AI deployment docs and zero runtime dependencies: OK');
