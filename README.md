# Nexus Contracts

A desktop wallet module for Nexus conditional payments. You lock a payment with your own rules: pick a template (escrow, time-lock, return if unclaimed), or build the rules with blocks or code. The block builder and the code console edit the same contract.

## How it works

A Nexus payment (DEBIT) can carry a condition. The core checks the condition when someone claims the payment (CREDIT). The core's API can only add one kind of condition, an expiry, so this module builds and signs the transactions itself and sends them with `ledger/submit/transaction`, the same way the DEX does. The username, password and PIN stay in the module's memory only.

Deadlines use `ledger.timestamp`, the time of the best block. The claim's own timestamp can be backdated, so the module never uses it.

An escrow needs a decision register. The arbiter creates it first: a local name `escrow-<id>` holding 0 (open), 1 (release) or 2 (refund). The condition checks both the register's owner and its value. The arbiter can never claim the payment.

## Layout

- `core/`: the condition language.
  - Structure (`condition/ast.ts`), byte encoding and decoding (`condition/encode.ts`).
  - Text form for the console (`condition/text.ts`) and plain-language description (`condition/describe.ts`).
  - Templates (`templates.ts`), the builder's block model (`blocks.ts`) and the contract kind (`kind.ts`).
- `app/`: the React page.
  - Template forms, block builder, code console and review.
  - "My contracts", with claim and take-back.
  - The arbiter's escrow ids and decisions.
- `module/build.mjs`: builds the wallet module into `module/dist` (one classic script, `nxs_package.json` and `nxs_package.dev.json`).

It reuses the transaction code of the browser wallet (`../wallet/src/lib`) and the node client of the DEX (`../dex`).

## Tests

- `cd core && npx vitest run src/condition.test.ts`:
  - the encoder reproduces the wallet's expiry condition and the DEX hash lock byte for byte;
  - round trips through bytes, text and blocks;
  - console errors and plain words.
- `NEXUS_NODE=http://127.0.0.1:7080 npx vitest run src/live.int.test.ts` (private chain, about 4 minutes): each template on chain. Allowed claims are accepted; the others are refused by the core with "conditions not satisfied".

## Build

```
npm install
node module/build.mjs
```

Then add `module/dist` in the wallet as a development module (Settings > Application, developer mode). Outside developer mode a module must be verified by Nexus before the wallet loads it.
