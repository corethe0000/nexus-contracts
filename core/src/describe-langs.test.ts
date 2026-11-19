//prints the plain words of every template in each language (the joined phrases are the hard part to translate);
//it fails only when a translated sentence still has an unfilled {placeholder}
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe as suite, expect, it } from 'vitest';
import { describe } from './condition/describe';
import { codeHash, codeRelease } from './code';
import { escrow, returnIfUnclaimed, timeLock } from './templates';

const dir = join(__dirname, '../../app/src/locales');
const alice = 'a1'.repeat(32);
const bob = 'b2'.repeat(32);
const carol = 'c3'.repeat(32);
const contracts = [
  returnIfUnclaimed({ sender: alice, recipient: bob, deadline: 1790000000 }),
  timeLock({ sender: alice, recipient: bob, unlock: 1790000000, cancelable: true }),
  escrow({ sender: alice, recipient: bob, arbiter: carol, id: 'order42', fallback: 1800000000 }),
  codeRelease({ sender: alice, recipient: bob, hash: codeHash('ABCD-EFGH-JKLM'), takeBackFrom: 1800000000 }),
];

suite('plain words in every language', () => {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json') && x !== 'en.json')) {
    it(f, () => {
      const pack = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, string>;
      const t = (text: string, vars?: Record<string, string>) => {
        const s = pack[text] || text;
        return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m) : s;
      };
      const labels = { [alice]: t('You'), [bob]: 'bob', [carol]: 'carol' };
      const lines = contracts.flatMap((c) => describe(c, { labels, sender: alice, me: alice, time: () => '1.1.2027', t }));
      if (process.env.SHOW_LANG && f.startsWith(process.env.SHOW_LANG)) {
        console.log(`${f}\n${lines.join('\n')}`);
      }
      for (const l of lines) {
        expect(l).not.toMatch(/\{\w+\}/);
      }
    });
  }
});
