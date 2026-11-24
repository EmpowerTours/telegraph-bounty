// Held-out target: HookVault (+ its NotifyToken). Scenario and invariant, executed by
// verifier/verify-target.js.
import { parseEther } from "viem";

const SEED = [parseEther("3"), parseEther("3"), parseEther("4")];

export default {
  id: "hook-vault",
  title: "HookVault: custody vault for a wrapped-ether token with transfer notifications",
  vulnerable: { file: "HookVault.sol", contract: "HookVault" },
  patched: { file: "HookVaultPatched.sol", contract: "HookVault" },
  invariant:
    "after the attack, every honest depositor can withdraw their full vault balance and ends up holding at least the tokens they deposited",
  attackValueWei: parseEther("1"),
  scenario: [
    "A fresh chain. The deployer deploys HookVault (no constructor arguments); its constructor deploys the NotifyToken it custodies (vault.token()).",
    "Three honest users (EOAs) each call token.wrap{value: x}() for x = 3, 3 and 4 ether, then token.approve(vault, x) and vault.deposit(x).",
    "The attacker deploys Exploit(vault) with 1 ether and calls run() once (5,000,000 gas).",
    "Then each honest user calls vault.withdraw(vault.balanceOf(self)) (skipped if 0).",
    "Invariant: each honest user's token balance afterwards is at least what they deposited (3, 3 and 4 ether worth).",
  ],
  async setup(ctx) {
    const { target, accounts } = ctx;
    const token = await ctx.read(target.address, target.abi, "token");
    const tokenAbi = ctx.artifacts.NotifyToken.abi;
    for (const [i, u] of accounts.users.entries()) {
      await ctx.mustSend(u, token, tokenAbi, "wrap", [], { value: SEED[i] });
      await ctx.mustSend(u, token, tokenAbi, "approve", [target.address, SEED[i]]);
      await ctx.mustSend(u, target.address, target.abi, "deposit", [SEED[i]]);
    }
  },
  async after(ctx) {
    const { target, accounts } = ctx;
    const steps = [];
    for (const [i, u] of accounts.users.entries()) {
      const bal = await ctx.read(target.address, target.abi, "balanceOf", [u]);
      if (bal === 0n) {
        steps.push({ user: i, step: "withdraw", amount: "0", status: "skipped" });
        continue;
      }
      const r = await ctx.send(u, target.address, target.abi, "withdraw", [bal]);
      steps.push({ user: i, step: "withdraw", amount: bal.toString(), status: r.status });
    }
    return steps;
  },
  async check(ctx) {
    const { target, accounts } = ctx;
    const token = await ctx.read(target.address, target.abi, "token");
    const tokenAbi = ctx.artifacts.NotifyToken.abi;
    const held = [];
    for (const u of accounts.users) held.push(await ctx.read(token, tokenAbi, "balanceOf", [u]));
    return {
      holds: held.every((h, i) => h >= SEED[i]),
      observed: {
        deposited_wei: SEED.map(String),
        honest_token_balance_wei: held.map(String),
        vault_token_balance_wei: (await ctx.read(token, tokenAbi, "balanceOf", [target.address])).toString(),
        total_deposits_wei: (await ctx.read(target.address, target.abi, "totalDeposits")).toString(),
      },
    };
  },
};
