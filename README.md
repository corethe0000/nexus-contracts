# Nexus Contracts

A desktop wallet module for Nexus conditional payments. You lock a payment with your own rules: pick a template (escrow, time-lock, return if unclaimed, release with a code, approvals k of n, crowdfunding, vesting, milestones), or build the rules with blocks or code. The block builder and the code console edit the same contract.

## How it works

A Nexus payment (DEBIT) can carry a condition. The core checks the condition when someone claims the payment (CREDIT). The core's API can only add one kind of condition, an expiry, so this module builds and signs the transactions itself and sends them with `ledger/submit/transaction`, the same way the DEX does. The username, password and PIN stay in the module's memory only.

Deadlines use `ledger.timestamp`, the time of the best block. The claim's own timestamp can be backdated, so the module never uses it.

An escrow needs a decision register. The arbiter creates it first: a local name `escrow-<id>` holding 0 (open), 1 (release) or 2 (refund). The condition checks both the register's owner and its value. The arbiter can never claim the payment.

Release with a code: the contract holds only the hash of a code. To claim, the recipient writes the code into its own code box (a local name `nxcode`, set up once) and then credits. The chain checks the box as it was in the last block, so the write and the claim are two transactions with a block between them. The box must exist before the payment is sent.

Approvals: k of n approvers each create the same deal id (their own `escrow-<id>` register) and decide release or refund. Conditions cannot count, so every group of k approvers is its own way to claim (and every group of n-k+1 for the refund); up to 5 approvers. Crowdfunding is an escrow that many backers send with the same arbiter and campaign id: one decision settles all of them. Vesting and milestones send several payments in one transaction (up to 50), each with its own time-lock or code.

Claim fee: the core counts what checking a condition costs (each register read about 4100). Up to 4096 it is free; above it the claim must carry a FEE contract for the rest, except on private / hybrid chains. `core/src/cost.ts` mirrors the core's table and the claim adds the fee (an escrow claim about 0.013 NXS, 2 of 3 approvals about 0.1 NXS). Not yet tried on a chain that charges fees.

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
- `NEXUS_NODE=http://127.0.0.1:7080 npx vitest run src/live.int.test.ts src/live-code.int.test.ts` (private chain, about 4 minutes): each template on chain. Allowed claims are accepted; the others are refused by the core with "conditions not satisfied".

## Translations

The module speaks the wallet's language (the same 17 languages plus English). Texts go through `t('English text', { placeholder })` (`app/src/lib/i18n.ts`); `app/src/locales/<code>.json` maps each English text to its translation, and a missing entry shows English.

- `node tools/i18n.mjs keys` collects every text into `tools/i18n-keys.json`.
- `node tools/i18n.mjs check` lists missing texts, wrong placeholders and banned characters per language.
- `node tools/i18n.mjs prune` drops texts the code no longer uses.

The plain-words sentences are built from phrases (`{who} can claim {conditions}`, `before {time}` ...); `core/src/describe-langs.test.ts` prints them per language (`SHOW_LANG=hr`).

## Sharing and the wallet's Overview

"Share with the recipient" copies a message with `nexus-contract:<transaction id>`; the recipient pastes the whole message into My contracts > Add. The number of payments waiting for you is saved in the module storage (`overview`), which the wallet's Overview shows with an Open link (wallet branch release-fixes).

## Build

```
npm install
node module/build.mjs
```

Then add `module/dist` in the wallet as a development module (Settings > Application, developer mode). Outside developer mode a module must be verified by Nexus before the wallet loads it.
