//builds the Nexus Contracts desktop wallet module into module/dist: the app in vite mode "module", the icon and
//nxs_package.json listing every file (the wallet refuses files a module does not list), plus nxs_package.dev.json for
//a folder added as a development module (Settings > Application, developer mode).
//  node module/build.mjs
import { execSync } from 'node:child_process';
import { copyFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(here, 'dist');

execSync('npx vite build --mode module', { cwd: resolve(root, 'app'), stdio: 'inherit', env: { ...process.env, CONTRACTS_MODULE_OUT: out } });

//one classic script: module scripts do not load from file://
const indexPath = join(out, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/<script type="module" crossorigin src=/g, '<script defer src=').replace(/<link rel="stylesheet" crossorigin /g, '<link rel="stylesheet" ');
writeFileSync(indexPath, html);
copyFileSync(join(here, 'icon.svg'), join(out, 'icon.svg'));

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) {
      walk(p);
    } else {
      files.push(relative(out, p).split(sep).join('/'));
    }
  }
};
walk(out);
const app = JSON.parse(readFileSync(resolve(root, 'app/package.json'), 'utf8'));
const description = 'Lock a payment with your own rules: escrow, time-lock, return if unclaimed, or build them with blocks and code.';
const pkg = {
  name: 'nexus-contracts',
  displayName: 'Nexus Contracts',
  version: app.version,
  targetWalletVersion: '3.1.5',
  description,
  type: 'app',
  entry: 'index.html',
  icon: 'icon.svg',
  author: { name: 'Nexus', email: 'impressions@nexus.io' },
  files: files.filter((f) => f !== 'nxs_package.json' && f !== 'nxs_package.dev.json').sort(),
};
writeFileSync(join(out, 'nxs_package.json'), JSON.stringify(pkg, null, 2) + '\n');
const dev = { name: 'nexus-contracts-dev', displayName: 'Nexus Contracts (dev)', description, type: 'app', entry: pkg.entry, icon: pkg.icon };
writeFileSync(join(out, 'nxs_package.dev.json'), JSON.stringify(dev, null, 2) + '\n');
console.log(`module built in ${out}: ${pkg.files.length} files`);
