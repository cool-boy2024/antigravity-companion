// Deterministic ZIP (stored entries) using only Node's standard library.
import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const files = [];
async function collect(relative) {
  const absolute = path.join(root, relative);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error('Release files cannot be symlinks');
  if (info.isDirectory()) {
    for (const entry of (await readdir(absolute)).sort()) await collect(`${relative}/${entry}`);
  } else if (info.isFile()) files.push(relative);
}
for (const entry of ['src', 'web', 'data', 'assets', 'skills', 'docs', 'scripts', 'test', 'plugin.json', 'hooks.json', 'package.json', 'README.md', 'AI_INSTALL.md', 'CLAUDE.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE']) await collect(entry);
const table = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
function crc32(data) { let crc = 0xffffffff; for (const byte of data) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
const locals = [];
const directory = [];
let offset = 0;
for (const file of files.sort()) {
  const name = Buffer.from(file);
  const data = await readFile(path.join(root, file));
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(0x5c21, 12); // 2026-01-01, reproducible DOS date
  header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
  central.writeUInt16LE(0x5c21, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  locals.push(header, name, data); directory.push(central, name); offset += header.length + name.length + data.length;
}
const centralData = Buffer.concat(directory);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(centralData.length, 12); end.writeUInt32LE(offset, 16);
const archive = Buffer.concat([...locals, centralData, end]);
const output = path.join(root, 'dist'); await mkdir(output, { recursive: true });
const filename = `gravity-companion-${pkg.version}.zip`;
await writeFile(path.join(output, filename), archive);
await writeFile(path.join(output, 'SHA256SUMS'), `${createHash('sha256').update(archive).digest('hex')}  ${filename}\n`);
console.log(`${filename}: ${files.length} files, ${archive.length} bytes`);
