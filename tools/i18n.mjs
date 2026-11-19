//translations of the module: app/src/locales/<code>.json maps each English text to its translation
//  node tools/i18n.mjs keys            writes tools/i18n-keys.json (every text in t('...') calls and the plain-words phrases)
//  node tools/i18n.mjs check [code]    per language: missing and unknown keys, placeholders, characters that must not appear
//  node tools/i18n.mjs prune           drops keys no longer in the source from every language file
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localesDir = join(root, 'app/src/locales');
const keysFile = join(root, 'tools/i18n-keys.json');

function files(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== 'locales' && f !== 'node_modules') {
        files(p, out);
      }
    } else if (/\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f)) {
      out.push(p);
    }
  }
  return out;
}

//string literal after t( or phrase( : '...', "..." or `...` without ${}
const callRe = /\b(?:t|phrase)\(\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\$]|\\.)*)`)/g;
const unescape = (s) => s.replace(/\\(.)/g, '$1');

function extract() {
  const keys = new Set();
  //messages of the core's checks that the page shows (blocks, templates, codes)
  for (const f of ['blocks.ts', 'templates.ts', 'code.ts'].map((x) => join(root, 'core/src', x))) {
    for (const m of readFileSync(f, 'utf8').matchAll(/new Error\('((?:[^'\\]|\\.)*)'\)/g)) {
      keys.add(unescape(m[1]));
    }
  }
  for (const f of [...files(join(root, 'app/src')), join(root, 'core/src/condition/describe.ts')]) {
    const src = readFileSync(f, 'utf8');
    for (const m of src.matchAll(callRe)) {
      keys.add(unescape(m[1] ?? m[2] ?? m[3]));
    }
  }
  return [...keys].filter((k) => k.trim()).sort();
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
//figure dash, en dash, em dash, horizontal bar and the four arrows, written as codes
const bannedChars = [0x2012, 0x2013, 0x2014, 0x2015, 0x2190, 0x2191, 0x2192, 0x2193].map((c) => String.fromCharCode(c));
const hasBanned = (s) => bannedChars.some((c) => s.includes(c));

function check(code) {
  const keys = JSON.parse(readFileSync(keysFile, 'utf8'));
  const pack = JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'));
  const problems = [];
  for (const k of keys) {
    const v = pack[k];
    if (typeof v !== 'string' || !v.trim()) {
      problems.push(`missing: ${k}`);
      continue;
    }
    if (placeholders(v) !== placeholders(k)) {
      problems.push(`placeholders differ: ${k} => ${v}`);
    }
    if (hasBanned(v)) {
      problems.push(`dash or arrow character: ${v}`);
    }
    //the joiners keep their spaces, or words run together
    if (/^\s|\s$/.test(k) && (v.startsWith(' ') !== k.startsWith(' ') || v.endsWith(' ') !== k.endsWith(' '))) {
      problems.push(`edge spaces differ: "${k}" => "${v}"`);
    }
  }
  for (const k of Object.keys(pack)) {
    if (!keys.includes(k)) {
      problems.push(`unknown key: ${k}`);
    }
  }
  return problems;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === 'keys') {
  const keys = extract();
  writeFileSync(keysFile, JSON.stringify(keys, null, 1) + '\n');
  console.log(`${keys.length} texts in ${keysFile}`);
} else if (cmd === 'check') {
  const codes = arg ? [arg] : readdirSync(localesDir).filter((f) => f.endsWith('.json') && f !== 'en.json').map((f) => f.slice(0, -5));
  let bad = 0;
  for (const c of codes) {
    const p = check(c);
    bad += p.length;
    console.log(`${c}: ${p.length ? `${p.length} problems` : 'ok'}`);
    p.slice(0, 15).forEach((x) => console.log(`  ${x}`));
  }
  process.exit(bad ? 1 : 0);
} else if (cmd === 'prune') {
  const keys = new Set(JSON.parse(readFileSync(keysFile, 'utf8')));
  for (const f of readdirSync(localesDir).filter((x) => x.endsWith('.json') && x !== 'en.json')) {
    const p = join(localesDir, f);
    const pack = JSON.parse(readFileSync(p, 'utf8'));
    const kept = Object.fromEntries(Object.entries(pack).filter(([k]) => keys.has(k)));
    writeFileSync(p, JSON.stringify(kept, null, 1) + '\n');
  }
  console.log('pruned');
} else {
  console.log('usage: node tools/i18n.mjs keys | check [code] | prune');
}
