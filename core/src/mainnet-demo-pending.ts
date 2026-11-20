//Creates one small "return if unclaimed" contract from R to B on mainnet, left UNCLAIMED, so the recipient shows a
//waiting-to-claim balance (to see the wallet's claim notice). Config as mainnet-fee.ts.
//  tsx core/src/mainnet-demo-pending.ts /tmp/mainnet-fee.json
import { readFileSync } from 'node:fs';
import { debitContract } from '../../../wallet/src/lib/tritium';
import { NexusNode, type Credentials } from '../../../dex/core/src/nexus/node';
import { encode } from './condition/encode';
import { returnIfUnclaimed } from './templates';

type U = Credentials & { account: string };
const cfg = JSON.parse(readFileSync(process.argv[2]!, 'utf8'));
const node = new NexusNode(cfg.url, cfg.auth);
const R: U = cfg.users.R, B: U = cfg.users.B;
const amount = BigInt(Math.round(0.1 * 1e6));

async function main() {
  const r = await node.accountState(R.account);
  const b = await node.accountState(B.account);
  const deadline = Math.floor(Date.now() / 1000) + 7 * 86400;
  const cond = returnIfUnclaimed({ sender: r.owner, recipient: b.owner, deadline });
  const tx = await node.submit(R, r.owner, (ts) => [debitContract({ from: { address: R.account, state: r }, to: B.account, amount, condition: encode(cond) }, ts)]);
  await node.waitConfirmed(tx);
  console.log(`sent 0.1 NXS return-if-unclaimed ${R.username} -> ${B.username}, tx ${tx.slice(0, 12)} (recipient must claim it)`);
}
main().catch((e) => { console.error('FAILED', e); process.exit(1); });
