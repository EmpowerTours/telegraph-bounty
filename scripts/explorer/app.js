// Explorer page logic. Data is inlined by scripts/build-explorer.mjs.
const DATA = JSON.parse(document.getElementById("data").textContent);
const CLS = {
  reentrancy: "Re-entrancy",
  "access-control": "Access control",
  "oracle-manipulation": "Price-oracle manipulation",
  "share-inflation": "Share inflation",
  "unchecked-return": "Unchecked return value",
};
const ROLE = {
  review: "Security review",
  triage: "Triage",
  patch_verify: "Patch check",
};
const short = (h) => (h ? h.slice(0, 10) + "…" + h.slice(-4) : "");
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const bs = (tx) =>
  `<a class="mono" href="https://base-sepolia.blockscout.com/tx/${tx}" target="_blank" rel="noopener">${short(tx)}</a>`;
const local = (tx) =>
  tx
    ? `<span class="mono">${short(tx)}</span> <span class="chip">local chain</span>`
    : "-";
const cls = (c) => CLS[c] || c || "bug";
const usd = (n) => "$" + Number(n).toFixed(2);

let R = 0; // run index
let cur = 0; // target index
let timer = null;

function slug(r) {
  return r.kind === "live" ? "live-" + r.at.slice(0, 10) : "offline";
}

function reviewState(t) {
  const v = t.review.verdict;
  if (v === "wrong")
    return {
      pill: "wrong",
      text:
        DATA.runs[R].kind === "live"
          ? "review said no defect"
          : "mock review said no defect",
    };
  if (v === "right") return { pill: "right", text: "review found it" };
  return { pill: "none", text: "no review delivered" };
}

function runs() {
  document.getElementById("runs").innerHTML = DATA.runs
    .map(
      (r, i) =>
        `<button type="button" aria-pressed="${i === R}" data-r="${i}">${esc(r.label)}</button>`,
    )
    .join("");
  document.querySelectorAll("#runs button").forEach(
    (b) =>
      (b.onclick = () => {
        selectRun(+b.dataset.r, true);
      }),
  );
}

function strip() {
  const r = DATA.runs[R];
  const T = r.targets;
  const purchases = T.reduce((n, t) => n + t.purchases.length, 0);
  const settled = T.reduce(
    (n, t) => n + t.purchases.filter((p) => p.status === 200 && p.tx).length,
    0,
  );
  const reviewed = T.filter(
    (t) => t.review.verdict === "wrong" || t.review.verdict === "right",
  );
  const right = reviewed.filter((t) => t.review.verdict === "right").length;
  const live = r.kind === "live";
  document.getElementById("strip").innerHTML = [
    ["good", `${r.solved}/${T.length}`, "bugs proven by the verifier"],
    reviewed.length
      ? [
          "bad",
          `${right}/${reviewed.length}`,
          live
            ? "paid reviews that found the bug"
            : "mock reviews that found the bug",
        ]
      : ["", "none", "reviews delivered (payments failed)"],
    live
      ? [
          "",
          `${settled}/${purchases}`,
          "Telegraph purchases settled on Base Sepolia",
        ]
      : [
          "",
          `${purchases}`,
          "purchases from a local Telegraph mock, nothing paid",
        ],
    [
      "",
      `${usd(live ? settled * 0.01 : 0)} + ${usd(r.modelCost)}`,
      `Telegraph settled + model cost (${r.modelCalls} model calls)`,
    ],
    [
      "good",
      `${T.filter((t) => t.solved).length} ETH`,
      "paid out to the hunter (local chain)",
    ],
  ]
    .map(
      ([c, b, s]) =>
        `<div class="stat ${c}"><b>${b}</b><small>${s}</small></div>`,
    )
    .join("");
  const note = document.getElementById("runnote");
  note.textContent = r.note || "";
  note.hidden = !r.note;
  document.getElementById("listlbl").textContent =
    `${T.length} bounties · 1 ETH each`;
}

function list() {
  const r = DATA.runs[R];
  document.getElementById("list").innerHTML = r.targets
    .map((t, i) => {
      const rs = reviewState(t);
      return `<button type="button" class="bounty" aria-current="${i === cur}" data-i="${i}">
        <span class="n">${esc(t.id)}</span><span class="pill ${t.solved ? "paid" : "none"}">${t.solved ? "Paid" : "Open"}</span>
        <span class="c">${esc(cls(t.cls))} · ${rs.text}</span></button>`;
    })
    .join("");
  document.querySelectorAll(".bounty").forEach(
    (b) =>
      (b.onclick = () => {
        cur = +b.dataset.i;
        stop();
        list();
        show(4);
      }),
  );
}

function opinionBox(t, live) {
  const rv = t.review;
  const pr = t.purchases.find((p) => p.role === "review");
  if (rv.verdict === "wrong" || rv.verdict === "right") {
    const who = live
      ? `${esc(rv.reviewer)}, $0.01${rv.tx ? ", " + bs(rv.tx) : ""}`
      : "Local mock miner, nothing paid";
    return `<div class="op"><span class="lbl">${live ? "Paid review (opinion)" : "Mock review (opinion)"}</span>
      <strong>${esc(rv.label || "No security defect found")}</strong>
      <p>${who}</p><p>${esc(rv.summary || "")}</p></div>`;
  }
  return `<div class="op"><span class="lbl">Paid review (opinion)</span><strong>No review delivered</strong>
    <p>The purchase returned HTTP ${pr ? pr.status : "-"}: the payment did not settle, so nothing was bought and nothing reached the model.</p></div>`;
}

function attemptsText(t) {
  const last = t.attempts[t.attempts.length - 1] || {};
  const failed = t.attempts.filter((a) => a.valid === false);
  let s = `${esc(last.model || "-")}, attempt ${t.attempts.length}`;
  if (failed.length)
    s += `. Rejected first: ${failed.map((a) => `attempt ${a.n} (${esc(a.reason)})`).join("; ")}; the retry got that feedback`;
  return s;
}

function show(upto) {
  const r = DATA.runs[R];
  const live = r.kind === "live";
  const t = r.targets[cur];
  const st = (n) => (n <= upto ? "done" : "dim");
  const cost = t.attempts.reduce((n, a) => n + (a.cost || 0), 0);
  const purchaseRows = t.purchases
    .map((p) => {
      const paid = !live
        ? `<span class="chip">mock</span>`
        : p.status === 200
          ? `$0.01 <span class="ok">200</span>`
          : `<span class="chip">HTTP ${p.status}</span>`;
      const where = p.tx ? bs(p.tx) : live ? "not settled" : "-";
      return `<tr><td>${ROLE[p.role] || esc(p.role)}</td><td>${esc(p.miner || (live ? "-" : "local mock"))}</td><td>${paid}</td><td>${where}</td></tr>`;
    })
    .join("");
  document.getElementById("case").innerHTML = `
    <div class="casehead"><div><div class="lbl">Bounty #${esc(t.bounty)} · reward 1 ETH</div><h2>${esc(t.id)}</h2></div>
      <button type="button" class="replay" id="replay">Replay this hunt</button></div>
    <div class="vs">
      ${opinionBox(t, live)}
      <div class="pr"><span class="lbl">Verifier (proof)</span><strong>${t.solved ? "Bug proven: " + esc(cls(t.cls)) : "No valid proof"}</strong>
        <p>${esc(t.reason || "")}${t.solved ? ". Escrow paid 1 ETH." : ""}</p></div>
    </div>
    <ol class="steps">
      <li class="step ${st(1)}"><span class="num">1</span><div><h3>Poster locks the reward and the rule</h3>
        <dl class="kv"><dt>Invariant</dt><dd class="mono">${esc(t.invariant)}</dd><dt>Reward</dt><dd>1 ETH in BountyEscrow</dd></dl></div></li>
      <li class="step ${st(2)}"><span class="num">2</span><div><h3>Hunter buys reviews on Telegraph over x402</h3>
        <div class="tw"><table><tr><th>Purchase</th><th>Provider</th><th>Paid</th><th>Settlement</th></tr>${purchaseRows}</table></div></div></li>
      <li class="step ${st(3)}"><span class="num">3</span><div><h3>Claude writes an exploit it has never seen</h3>
        <dl class="kv"><dt>Model</dt><dd>${attemptsText(t)}</dd><dt>Model cost</dt><dd>${live ? "$" + cost.toFixed(4) : "$0 (recorded output replayed)"}</dd><dt>Commit</dt><dd>${local(t.commitTx)}</dd></dl>
        ${t.sol ? `<details><summary>Show the exploit (${t.sol.trim().split("\n").length} lines)</summary><pre>${esc(t.sol)}</pre></details>` : ""}</div></li>
      <li class="step ${st(4)}"><span class="num">4</span><div><h3>Deterministic verifier decides</h3>
        <div class="checks"><div class="check"><b>Vulnerable contract</b><span class="ok">Invariant broken</span> by the exploit</div>
        <div class="check"><b>Patched contract</b><span class="ok">Invariant holds</span> against the same exploit</div></div>
        <dl class="kv" style="margin-top:10px"><dt>Verdict</dt><dd>${t.solved ? "Valid. 1 ETH credited to the hunter that committed the proof" : "Invalid"}</dd><dt>Payout tx</dt><dd>${local(t.resolveTx)}</dd></dl></div></li>
    </ol>`;
  document.getElementById("replay").onclick = replay;
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function replay() {
  stop();
  let k = 0;
  show(0);
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    show(4);
    return;
  }
  timer = setInterval(() => {
    k++;
    show(k);
    if (k >= 4) stop();
  }, 1100);
}

function selectRun(i, push) {
  stop();
  R = i;
  const T = DATA.runs[R].targets;
  cur = Math.max(
    0,
    T.findIndex((t) => t.id === "lend-pool"),
  );
  runs();
  strip();
  list();
  show(4);
  if (push) history.replaceState(null, "", "#" + slug(DATA.runs[R]));
}

document.querySelectorAll("[data-copy]").forEach(
  (b) =>
    (b.onclick = async () => {
      const el = document.getElementById(b.dataset.copy);
      try {
        await navigator.clipboard.writeText(el.textContent);
        b.textContent = "Copied";
      } catch (e) {
        const sel = getSelection();
        const rg = document.createRange();
        rg.selectNodeContents(el);
        sel.empty();
        sel.addRange(rg);
        b.textContent = "Selected";
      }
      setTimeout(() => (b.textContent = "Copy"), 1500);
    }),
);

function fromHash() {
  const h = location.hash.slice(1);
  const i = DATA.runs.findIndex((r) => slug(r) === h);
  selectRun(i >= 0 ? i : 0, false);
}
addEventListener("hashchange", fromHash);
fromHash();
