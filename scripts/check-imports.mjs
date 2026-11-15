/* Static import/export checker for this worker (no build step needed).
 * Catches the mistake a rename always makes: importing a name that the module
 * does not actually export. Run: npm run check:imports
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

async function jsFiles(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await jsFiles(full)));
    else if (entry.name.endsWith('.js')) found.push(full);
  }
  return found;
}

function exportsOf(source) {
  const names = new Set();
  const decl = /export\s+(?:async\s+)?(?:function\*?|class)\s+([A-Za-z0-9_$]+)/g;
  const consts = /export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g;
  const braces = /export\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(decl)) names.add(match[1]);
  for (const match of source.matchAll(consts)) names.add(match[1]);
  for (const match of source.matchAll(braces)) {
    for (const part of match[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      const as = piece.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/export\s+default/.test(source)) names.add('default');
  return names;
}

function importsOf(source) {
  const list = [];
  const re = /import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(re)) {
    const clause = match[1].trim();
    const from = match[2];
    if (!from.startsWith('.')) continue;                       // skip hono / npm packages
    const named = clause.match(/\{([\s\S]*)\}/);
    if (!named) continue;
    for (const part of named[1].split(',')) {
      const piece = part.trim();
      if (!piece) continue;
      list.push({ from, name: piece.split(/\s+as\s+/)[0].trim() });
    }
  }
  return list;
}

const files = await jsFiles(path.join(ROOT, 'src'));
const cache = new Map();
async function exportsFor(file) {
  if (cache.has(file)) return cache.get(file);
  const source = await readFile(file, 'utf8');
  const set = exportsOf(source);
  cache.set(file, set);
  return set;
}

const problems = [];
for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const { from, name } of importsOf(source)) {
    const target = path.resolve(path.dirname(file), from);
    let available;
    try {
      available = await exportsFor(target);
    } catch (err) {
      problems.push(`${path.relative(ROOT, file)} imports from missing file ${from}`);
      continue;
    }
    if (!available.has(name)) {
      problems.push(`${path.relative(ROOT, file)} imports "${name}" which ${from} does not export`);
    }
  }
}

if (problems.length) {
  console.error(`check:imports FAILED (${problems.length})`);
  for (const problem of problems) console.error(' - ' + problem);
  process.exit(1);
}
console.log(`check:imports OK (${files.length} files)`);
