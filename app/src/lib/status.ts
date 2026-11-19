//What a profile can do with a contract now: checks each way to claim against the block time and the arbiter's
//decision, the same parts the core checks. A way with a code block is shown as "maybe" (the core decides).
import { toWays, decisionIds, type Block, type Way } from '@nexus-contracts/core/src';
import type { ChainContract, DecisionState } from './chain';

export type WayCheck = { way: Way; mine: boolean; ready: 'yes' | 'no' | 'maybe'; waiting: string[] };

export interface ContractStatus {
  ways: WayCheck[];
  canClaim: boolean; //a way for me is ready now
  maybe: boolean; //a way for me depends on parts only the core can check
  waiting: string[]; //what my ways still wait for
  closed: boolean; //nothing left to claim
  broken: boolean; //can never be claimed (a register it reads is missing)
}

//beyond the date range (anyone can put any number in a contract) the plain number is shown
export const fmtTime = (t: number) => (Math.abs(t) > 8.64e12 ? `time ${t}` : new Date(t * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));

export function decisionKey(arbiter: string, id: string) {
  return `${arbiter}/${id}`;
}

function checkBlock(b: Block, me: string, now: number, decisions: Map<string, DecisionState>): { ok: boolean | null; mine?: boolean; wait?: string } {
  switch (b.kind) {
    case 'who':
      return { ok: b.genesis === me, mine: b.genesis === me };
    case 'before':
      return { ok: now < b.time, wait: now < b.time ? undefined : `ended ${fmtTime(b.time)}` };
    case 'from':
      return { ok: now >= b.time, wait: now >= b.time ? undefined : `from ${fmtTime(b.time)}` };
    case 'decision': {
      const d = decisions.get(decisionKey(b.arbiter, b.id));
      const ok = !!d?.exists && d.owner === b.arbiter && d.value === b.value;
      return { ok, wait: ok ? undefined : b.value === 1 ? 'the arbiter to release' : 'the arbiter to refund' };
    }
    case 'code':
      return { ok: null };
  }
}

//a claim goes into the claimer's own account: a way without a "who" block is open to the owner of the receiving
//account and to the sender only. A missing decision register fails every way (the core reads every part).
export function contractStatus(c: ChainContract, me: string, now: number, decisions: Map<string, DecisionState>, escrowIds: { arbiter: string; id: string }[], myAccounts: Set<string>): ContractStatus {
  const ways = c.condition ? toWays(c.condition, decisionIds(escrowIds)) : [];
  const canReceive = c.sender === me || myAccounts.has(c.to);
  const missing = ways.flat().some((b) => b.kind === 'decision' && decisions.get(decisionKey(b.arbiter, b.id))?.exists === false);
  const checks: WayCheck[] = ways.map((way) => {
    const hasWho = way.some((b) => b.kind === 'who');
    const codeWho = way.some((b) => b.kind === 'code' && /caller\.genesis/.test(b.text));
    let mine = !hasWho && canReceive;
    let ready: WayCheck['ready'] = codeWho ? 'maybe' : 'yes';
    const waiting: string[] = [];
    for (const b of way) {
      const r = checkBlock(b, me, now, decisions);
      if (r.mine) {
        mine = true;
      }
      if (r.ok === false) {
        ready = 'no';
        if (r.wait) {
          waiting.push(r.wait);
        }
      } else if (r.ok === null && ready === 'yes') {
        ready = 'maybe';
      }
    }
    if (missing) {
      ready = 'no';
      waiting.push('ended: the escrow register is missing, so the chain refuses every claim');
    }
    return { way, mine: mine && canReceive, ready, waiting };
  });
  const minez = checks.filter((w) => w.mine);
  const closed = c.open <= 0n;
  return {
    ways: checks,
    canClaim: !closed && minez.some((w) => w.ready === 'yes'),
    maybe: !closed && minez.some((w) => w.ready === 'maybe'),
    //a way that has ended for good ("ended ...") is not something to wait for
    waiting: minez.flatMap((w) => w.waiting).filter((x) => !x.startsWith('ended')),
    closed,
    broken: missing,
  };
}

/** Escrow decision registers a contract reads, from its decision blocks */
export function escrowRefs(c: ChainContract, known: { arbiter: string; id: string }[]): { arbiter: string; id: string }[] {
  if (!c.condition) {
    return [];
  }
  return toWays(c.condition, decisionIds(known))
    .flat()
    .filter((b): b is Extract<Block, { kind: 'decision' }> => b.kind === 'decision')
    .map((b) => ({ arbiter: b.arbiter, id: b.id }));
}
