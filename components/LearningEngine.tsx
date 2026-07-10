"use client";

import { useEffect, useState } from "react";
import type { LearnedRule } from "@/lib/similar-deals";

type Props = {
  workedRules: LearnedRule[];
  insights: string[];
  tiedInsight?: string | null;
};

const CSS = `
.dr-learn{--navy:#0F172A;--ink:#0F172A;--accent:#22c55e;--accentSoft:#dcfce7;--danger:#ef4444;--dangerSoft:#fee2e2;--warn:#f59e0b;--warnSoft:#fef3c7;--muted:#64748B;--line:#E2E8F0;--bg:#F8FAFC;--card:#FFFFFF;color:var(--ink);}
.dr-learn *{box-sizing:border-box;}
.dr-learn h1,.dr-learn h2,.dr-learn h3,.dr-learn h4{letter-spacing:-0.01em;margin:0;}
.dr-learn .brand{font-weight:800;color:var(--navy);}
.dr-learn .lede{color:var(--muted);font-size:13.5px;max-width:760px;margin:6px 0 4px;line-height:1.6;}
.dr-learn .eyebrow{font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;font-weight:800;color:var(--muted);}
.dr-learn section.block{margin-top:34px;}
.dr-learn .h2{font-size:19px;font-weight:700;color:var(--navy);margin-top:6px;}
.dr-learn .subtle{color:var(--muted);font-size:12.5px;margin-top:4px;}
.dr-learn .card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:0 1px 2px rgba(15,23,42,.04);}
.dr-learn .inputs{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-top:16px;}
@media(max-width:760px){.dr-learn .inputs{grid-template-columns:repeat(2,1fr);}}
.dr-learn .src{padding:12px;border-radius:12px;border:1px solid var(--line);background:#fff;position:relative;overflow:hidden;}
.dr-learn .src .k{font-size:11.5px;font-weight:700;color:var(--ink);}
.dr-learn .src .d{font-size:10.5px;color:var(--muted);margin-top:3px;line-height:1.35;}
.dr-learn .src .tag{position:absolute;top:8px;right:8px;font-size:8.5px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;padding:2px 6px;border-radius:20px;}
.dr-learn .tag.win{background:var(--accentSoft);color:#15803d;}
.dr-learn .tag.loss{background:var(--dangerSoft);color:#b91c1c;}
.dr-learn .tag.sig{background:#eef2ff;color:#4338ca;}
.dr-learn .flowdown{display:flex;justify-content:center;margin:14px 0 0;}
.dr-learn .flowdown svg{opacity:.5;}
.dr-learn .model{margin-top:8px;background:linear-gradient(180deg,#0f172a,#1e293b);color:#fff;border-radius:14px;padding:18px 20px;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;}
.dr-learn .model .t{font-size:15px;font-weight:700;}
.dr-learn .model .s{font-size:12px;color:#cbd5e1;margin-top:3px;max-width:560px;line-height:1.5;}
.dr-learn .model .badge{font-size:11px;font-weight:700;color:#22c55e;background:rgba(34,197,94,.14);border:1px solid rgba(34,197,94,.35);padding:6px 12px;border-radius:10px;white-space:nowrap;}
.dr-learn .loopwrap{margin-top:16px;background:linear-gradient(180deg,#0f172a,#131f38);border-radius:16px;padding:22px;position:relative;}
.dr-learn .loopgrid{display:grid;grid-template-columns:1fr 340px;gap:20px;align-items:center;}
@media(max-width:760px){.dr-learn .loopgrid{grid-template-columns:1fr;}}
.dr-learn .ring{position:relative;width:340px;height:340px;margin:0 auto;}
.dr-learn .ring svg{width:100%;height:100%;display:block;}
.dr-learn .track{fill:none;stroke:rgba(148,163,184,.25);stroke-width:2;stroke-dasharray:6 8;animation:dr-spin 24s linear infinite;transform-origin:center;}
@keyframes dr-spin{to{transform:rotate(360deg);}}
.dr-learn .pulse{fill:#22c55e;filter:drop-shadow(0 0 8px rgba(34,197,94,.9));}
.dr-learn .node{position:absolute;transform:translate(-50%,-50%);width:132px;text-align:center;}
.dr-learn .node .dot{width:11px;height:11px;border-radius:50%;background:#22c55e;margin:0 auto 6px;box-shadow:0 0 0 4px rgba(34,197,94,.16);}
.dr-learn .node .lab{font-size:11.5px;font-weight:700;color:#fff;line-height:1.25;}
.dr-learn .node .sub{font-size:10px;color:#94a3b8;margin-top:2px;line-height:1.25;}
.dr-learn .node.flash .dot{animation:dr-flash 1.1s ease;}
@keyframes dr-flash{0%{box-shadow:0 0 0 4px rgba(34,197,94,.16);}30%{box-shadow:0 0 0 12px rgba(34,197,94,.5);}100%{box-shadow:0 0 0 4px rgba(34,197,94,.16);}}
.dr-learn .loopside .eyebrow{color:#94a3b8;}
.dr-learn .loopside h3{color:#fff;font-size:16px;font-weight:700;margin-top:6px;}
.dr-learn .loopside p{color:#cbd5e1;font-size:12.5px;line-height:1.6;margin-top:8px;}
.dr-learn .loopside .pill{display:inline-block;margin-top:12px;font-size:11px;font-weight:700;color:#0f172a;background:#22c55e;padding:6px 12px;border-radius:8px;}
.dr-learn .rule{display:grid;grid-template-columns:1fr 1fr 1fr;gap:0;margin-top:16px;}
@media(max-width:760px){.dr-learn .rule{grid-template-columns:1fr;}}
.dr-learn .rule .col{padding:18px;border-right:1px solid var(--line);}
.dr-learn .rule .col:last-child{border-right:none;}
@media(max-width:760px){.dr-learn .rule .col{border-right:none;border-bottom:1px solid var(--line);}}
.dr-learn .rule .step{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);}
.dr-learn .rule h4{font-size:13.5px;font-weight:700;margin:8px 0 6px;color:var(--ink);}
.dr-learn .bar{display:flex;align-items:center;gap:8px;margin:6px 0;}
.dr-learn .bar .lbl{font-size:11px;width:74px;color:var(--muted);flex-shrink:0;}
.dr-learn .bar .track2{flex:1;height:16px;background:#f1f5f9;border-radius:5px;overflow:hidden;}
.dr-learn .bar .fill{height:100%;border-radius:5px;}
.dr-learn .bar .fill.win{background:var(--accent);}
.dr-learn .bar .fill.loss{background:var(--danger);}
.dr-learn .bar .val{font-size:11px;font-weight:700;width:56px;text-align:right;}
.dr-learn .rulebox{font-size:12.5px;color:var(--ink);line-height:1.5;}
.dr-learn .rulebox b{color:var(--navy);}
.dr-learn .presc{background:var(--accentSoft);border:1px solid rgba(34,197,94,.4);border-radius:10px;padding:11px 12px;margin-top:8px;}
.dr-learn .presc .p{font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.05em;color:#15803d;}
.dr-learn .presc .txt{font-size:12.5px;color:var(--ink);margin-top:4px;line-height:1.4;}
.dr-learn .liveGrid{display:grid;grid-template-columns:1fr 320px;gap:16px;margin-top:16px;align-items:stretch;}
@media(max-width:760px){.dr-learn .liveGrid{grid-template-columns:1fr;}}
.dr-learn .chartCard{padding:18px 18px 12px;}
.dr-learn .chartHead{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap;}
.dr-learn .legend{display:flex;gap:14px;font-size:11px;color:var(--muted);}
.dr-learn .legend .li{display:flex;align-items:center;gap:5px;}
.dr-learn .legend .sw{width:10px;height:3px;border-radius:2px;display:inline-block;}
.dr-learn .stats{display:flex;gap:22px;margin:14px 2px 6px;flex-wrap:wrap;}
.dr-learn .stat .n{font-size:26px;font-weight:800;color:var(--navy);letter-spacing:-.02em;line-height:1;transition:color .3s;}
.dr-learn .stat .n.bump{color:var(--accent);}
.dr-learn .stat .l{font-size:10.5px;color:var(--muted);margin-top:4px;text-transform:uppercase;letter-spacing:.05em;font-weight:700;}
.dr-learn svg.chart{width:100%;height:210px;display:block;margin-top:8px;}
.dr-learn .gridline{stroke:#eef2f7;stroke-width:1;}
.dr-learn .axislbl{fill:#94a3b8;font-size:9px;font-family:inherit;}
.dr-learn .lineRipe{fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;}
.dr-learn .lineRep{fill:none;stroke:#cbd5e1;stroke-width:2;stroke-dasharray:4 4;}
.dr-learn .area{fill:url(#g1);opacity:.5;}
.dr-learn .newdot{fill:var(--accent);}
.dr-learn .sidePanel{padding:16px;display:flex;flex-direction:column;}
.dr-learn .feed{flex:1;overflow:hidden;margin-top:10px;display:flex;flex-direction:column;gap:8px;}
.dr-learn .insight{border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:8px;padding:9px 11px;background:#fff;font-size:11.5px;color:var(--ink);line-height:1.4;animation:dr-slidein .5s ease;}
.dr-learn .insight.fresh{border-left-color:var(--accent);background:linear-gradient(90deg,var(--accentSoft),#fff);}
.dr-learn .insight .when{display:block;font-size:9.5px;color:var(--muted);margin-top:3px;font-weight:600;}
@keyframes dr-slidein{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:none;}}
.dr-learn .controls{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;}
.dr-learn .btn{border:none;cursor:pointer;font-family:inherit;font-weight:700;border-radius:11px;padding:12px 18px;font-size:13.5px;transition:transform .08s ease,filter .15s;}
.dr-learn .btn:active{transform:translateY(1px);}
.dr-learn .btn.primary{background:var(--navy);color:#fff;}
.dr-learn .btn.primary:hover{filter:brightness(1.12);}
.dr-learn .btn.ghost{background:#fff;border:1px solid var(--line);color:#334155;}
.dr-learn .hint{font-size:11px;color:var(--muted);margin-top:8px;}
.dr-learn .disc{margin-top:30px;border-top:1px solid var(--line);padding-top:14px;font-size:11px;color:var(--muted);line-height:1.6;}
.dr-learn .tabs{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;}
.dr-learn .tab{border:1px solid var(--line);background:#fff;color:#334155;font-family:inherit;font-weight:700;font-size:12px;padding:7px 13px;border-radius:9px;cursor:pointer;transition:all .12s;}
.dr-learn .tab:hover{border-color:#cbd5e1;}
.dr-learn .tab.active{background:var(--navy);color:#fff;border-color:var(--navy);}
`;

export function LearningEngine({ workedRules, insights, tiedInsight }: Props) {
  const [sel, setSel] = useState(0);
  useEffect(() => {
    const pool =
      insights && insights.length
        ? insights
        : ["Every close makes the next call sharper."];
    const $ = (id: string) => document.getElementById(id);

    let base: number[][] = [
      [40, 71],
      [80, 77],
      [120, 82],
      [160, 86],
      [200, 89],
      [247, 91],
    ];
    const repFlat = 64;
    let deals = 247,
      acc = 91,
      actionsTied = 2431;

    const X0 = 40,
      X1 = 590,
      Y0 = 20,
      Y1 = 190;
    const VMAX = 100,
      VMIN = 57;
    const sx = (i: number, n: number) =>
      X0 + (X1 - X0) * (n <= 1 ? 0 : i / (n - 1));
    const sy = (v: number) => Y0 + (Y1 - Y0) * (1 - (v - VMIN) / (VMAX - VMIN));

    function pathFrom(points: number[][], close: boolean) {
      let d = "";
      points.forEach((p, i) => {
        const x = sx(i, points.length),
          y = sy(p[1]);
        d += i
          ? ` L${x.toFixed(1)},${y.toFixed(1)}`
          : `M${x.toFixed(1)},${y.toFixed(1)}`;
      });
      if (close) {
        const lastX = sx(points.length - 1, points.length);
        d += ` L${lastX.toFixed(1)},${Y1} L${X0},${Y1} Z`;
      }
      return d;
    }
    function repPath(points: number[][]) {
      const x0 = sx(0, points.length),
        x1 = sx(points.length - 1, points.length),
        y = sy(repFlat);
      return `M${x0},${y} L${x1},${y}`;
    }

    function render(animateDot: boolean) {
      $("lineRipe")?.setAttribute("d", pathFrom(base, false));
      $("area")?.setAttribute("d", pathFrom(base, true));
      $("lineRep")?.setAttribute("d", repPath(base));
      const sd = $("statDeals");
      if (sd) sd.textContent = String(deals);
      const sa = $("statAcc");
      if (sa) sa.textContent = acc + "%";
      const ls = $("loopStat");
      if (ls)
        ls.textContent =
          actionsTied.toLocaleString() + " prescribed actions tied to outcomes";
      if (animateDot) {
        const last = base[base.length - 1];
        const cx = sx(base.length - 1, base.length),
          cy = sy(last[1]);
        const nd = $("newdot");
        if (nd) {
          nd.setAttribute("cx", String(cx));
          nd.setAttribute("cy", String(cy));
          (nd as unknown as HTMLElement).style.opacity = "1";
          nd.animate(
            [
              { r: 2, opacity: 1 },
              { r: 9, opacity: 0.35 },
              { r: 4, opacity: 1 },
            ] as Keyframe[],
            { duration: 650, easing: "ease-out" },
          );
        }
      }
    }

    function drawIn() {
      render(false);
      const p = $("lineRipe") as unknown as SVGPathElement | null;
      if (p) {
        const len = p.getTotalLength();
        p.style.strokeDasharray = String(len);
        p.style.strokeDashoffset = String(len);
        p.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], {
          duration: 1300,
          easing: "ease-out",
        });
        window.setTimeout(() => {
          p.style.strokeDasharray = "none";
          p.style.strokeDashoffset = "0";
        }, 1350);
      }
      $("area")?.animate([{ opacity: 0 }, { opacity: 0.5 }], {
        duration: 1400,
        easing: "ease-out",
      });
    }

    let poolIdx = 0;
    function addInsight(text: string, fresh: boolean) {
      const feed = $("feed");
      if (!feed) return;
      Array.from(feed.children).forEach((c) => {
        c.classList.remove("fresh");
        const w = c.querySelector(".when");
        if (w) w.textContent = "earlier";
      });
      const el = document.createElement("div");
      el.className = "insight" + (fresh ? " fresh" : "");
      el.innerHTML =
        text +
        '<span class="when">' +
        (fresh ? "just now" : "from your closed deals") +
        "</span>";
      feed.prepend(el);
      while (feed.children.length > 4) feed.removeChild(feed.lastChild as Node);
    }

    function flashLoop() {
      ["nodeOutcome", "nodeSharpen"].forEach((id, i) => {
        window.setTimeout(() => {
          const n = $(id);
          if (!n) return;
          n.classList.add("flash");
          window.setTimeout(() => n.classList.remove("flash"), 1100);
        }, i * 350);
      });
    }
    function bump(elId: string) {
      const e = $(elId);
      if (!e) return;
      e.classList.add("bump");
      window.setTimeout(() => e.classList.remove("bump"), 400);
    }

    function simulate() {
      const add = 1 + Math.floor(Math.random() * 3);
      deals += add;
      const gap = 97 - acc;
      acc = Math.min(97, Math.round(acc + Math.max(0.3, gap * 0.18)));
      actionsTied += 30 + Math.floor(Math.random() * 40);
      base.push([deals, acc]);
      if (base.length > 12) base = base.slice(base.length - 12);
      render(true);
      bump("statAcc");
      bump("statDeals");
      flashLoop();
      addInsight(pool[poolIdx % pool.length], true);
      poolIdx++;
    }

    function reset() {
      base = [
        [40, 71],
        [80, 77],
        [120, 82],
        [160, 86],
        [200, 89],
        [247, 91],
      ];
      deals = 247;
      acc = 91;
      actionsTied = 2431;
      poolIdx = 0;
      const feed = $("feed");
      if (feed) feed.innerHTML = "";
      addInsight(pool[pool.length - 1], false);
      addInsight(pool[0], false);
      drawIn();
    }

    const simBtn = $("simBtn");
    const resetBtn = $("resetBtn");
    simBtn?.addEventListener("click", simulate);
    resetBtn?.addEventListener("click", reset);

    // boot (idempotent across strict-mode remounts)
    const feed = $("feed");
    if (feed) feed.innerHTML = "";
    addInsight(pool[pool.length - 1], false);
    addInsight(pool[0], false);
    drawIn();

    return () => {
      simBtn?.removeEventListener("click", simulate);
      resetBtn?.removeEventListener("click", reset);
    };
  }, [insights]);

  const wr = workedRules[sel] ?? null;
  const wonPct = wr ? Math.round((wr.won.count / wr.won.total) * 100) : 0;
  const lostPct = wr ? Math.round((wr.lost.count / wr.lost.total) * 100) : 0;

  return (
    <div className="dr-learn">
      <style dangerouslySetInnerHTML={{ __html: CSS }} />

      <p className="lede">
        DealRipe does not run on a generic model. It learns what winning looks
        like inside your team, from the deals you closed, the deals you lost, and
        whether the moves it prescribed actually got done. Every deal that closes
        makes the next call sharper. Here is how.
      </p>

      {/* 1. INPUTS */}
      <section className="block">
        <div className="eyebrow">Step 1 · The inputs</div>
        <h2 className="h2">What it learns from</h2>
        <p className="subtle">
          Five signals from your own pipeline, tied to a single source of truth:
          did the deal close.
        </p>
        <div className="inputs">
          <div className="src">
            <span className="tag win">Won</span>
            <div className="k">Won deals</div>
            <div className="d">The plays and timing that closed, quote by quote.</div>
          </div>
          <div className="src">
            <span className="tag loss">Lost</span>
            <div className="k">Lost deals</div>
            <div className="d">Where the same shape fell apart, and why.</div>
          </div>
          <div className="src">
            <span className="tag sig">Signal</span>
            <div className="k">Qualification and timing</div>
            <div className="d">Which gate states, at which day, predict a close.</div>
          </div>
          <div className="src">
            <span className="tag sig">Signal</span>
            <div className="k">Objections and how they were handled</div>
            <div className="d">The responses that won, the ones that lost.</div>
          </div>
          <div className="src">
            <span className="tag sig">Signal</span>
            <div className="k">Prescribed actions and adherence</div>
            <div className="d">What DealRipe told the rep to do, and whether they did it.</div>
          </div>
        </div>
        <div className="flowdown">
          <svg width="40" height="30" viewBox="0 0 40 30">
            <path
              d="M20 2 L20 22 M12 15 L20 24 L28 15"
              fill="none"
              stroke="#0f172a"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="model">
          <div>
            <div className="t">Your winning motion model</div>
            <div className="s">
              Not a black box. Every weight traces back to deals you can name. It
              learns the patterns your best deals share and encodes them as the
              plays your whole team runs.
            </div>
          </div>
          <div className="badge">Tuned to your team, not the market</div>
        </div>
      </section>

      {/* 2. LOOP */}
      <section className="block">
        <div className="eyebrow">Step 2 · The engine</div>
        <h2 className="h2">The closed loop</h2>
        <p className="subtle">
          Prescribe, watch, learn, sharpen. This is the part a note-taking tool
          never reaches.
        </p>
        <div className="loopwrap">
          <div className="loopgrid">
            <div className="ring">
              <svg viewBox="0 0 340 340">
                <circle className="track" cx="170" cy="170" r="132" />
                <circle className="pulse" r="6">
                  <animateMotion
                    dur="7s"
                    repeatCount="indefinite"
                    rotate="auto"
                    path="M170,38 A132,132 0 1,1 169.9,38 Z"
                  />
                </circle>
              </svg>
              <div className="node" style={{ left: "50%", top: "5%" }}>
                <div className="dot" />
                <div className="lab">Prescribe the next move</div>
                <div className="sub">the question, email, commitment</div>
              </div>
              <div className="node" style={{ left: "95%", top: "50%" }}>
                <div className="dot" />
                <div className="lab">Rep acts on it</div>
                <div className="sub">or doesn&rsquo;t, both are signal</div>
              </div>
              <div
                className="node"
                id="nodeOutcome"
                style={{ left: "50%", top: "95%" }}
              >
                <div className="dot" />
                <div className="lab">Deal outcome</div>
                <div className="sub">won or lost, the ground truth</div>
              </div>
              <div
                className="node"
                id="nodeSharpen"
                style={{ left: "5%", top: "50%" }}
              >
                <div className="dot" />
                <div className="lab">Model sharpens</div>
                <div className="sub">weights update, plays improve</div>
              </div>
            </div>
            <div className="loopside">
              <div className="eyebrow">Why this compounds</div>
              <h3>Every close feeds the next call</h3>
              <p>
                When a deal closes, DealRipe checks what it prescribed, whether
                the rep did it, and how the deal ended. That result flows straight
                back into the model, so the next briefing on a similar deal is a
                little sharper than the last. The loop never stops running.
              </p>
              <span className="pill" id="loopStat">
                2,431 prescribed actions tied to outcomes
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* 3. WORKED RULE (from shared objection data) */}
      {wr && (
        <section className="block">
          <div className="eyebrow">Step 3 · A rule it learned, in the open</div>
          <h2 className="h2">One learned rule, with the receipts</h2>
          <p className="subtle">
            The same objections your reps see on the deal page. Pick one. Evidence
            to rule to prescription, so a skeptic can audit it.
          </p>
          <div className="tabs">
            {workedRules.map((r, i) => (
              <button
                key={r.id}
                className={"tab" + (i === sel ? " active" : "")}
                onClick={() => setSel(i)}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="card rule">
            <div className="col">
              <div className="step">The evidence</div>
              <h4>&ldquo;{wr.objection}&rdquo;</h4>
              <div className="bar">
                <span className="lbl">Won deals</span>
                <div className="track2">
                  <div className="fill win" style={{ width: `${wonPct}%` }} />
                </div>
                <span className="val" style={{ color: "#15803d" }}>
                  {wr.won.count} of {wr.won.total}
                </span>
              </div>
              <div className="bar">
                <span className="lbl">Lost deals</span>
                <div className="track2">
                  <div className="fill loss" style={{ width: `${lostPct}%` }} />
                </div>
                <span className="val" style={{ color: "#b91c1c" }}>
                  {wr.lost.count} of {wr.lost.total}
                </span>
              </div>
              <p className="subtle" style={{ marginTop: 8 }}>
                {wr.frequency}. Proven at {wr.provenAt}: &ldquo;{wr.evidenceQuote}
                &rdquo;
              </p>
            </div>
            <div className="col">
              <div className="step">The rule it formed</div>
              <div className="rulebox" style={{ marginTop: 8 }}>
                The winning behavior on this objection is: {wr.rule} DealRipe now
                weights this signal <b>{wr.weight}</b> and flags deals that miss
                it.
              </div>
            </div>
            <div className="col">
              <div className="step">What it now does about it</div>
              <div className="rulebox" style={{ marginTop: 8 }}>
                On every deal that hits the pattern, it fires a specific move to
                the rep before the next call:
              </div>
              <div className="presc">
                <div className="p">Prescription</div>
                <div className="txt">{wr.prescription}</div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* 4. COMPOUNDING + LIVE */}
      <section className="block">
        <div className="eyebrow">Step 4 · It gets better forever</div>
        <h2 className="h2">Sharper with every deal that closes</h2>
        <p className="subtle">
          Forecast accuracy climbs as the model learns from more of your closed
          deals. Rep-committed accuracy stays flat. Try it: close a deal.
        </p>
        <div className="liveGrid">
          <div className="card chartCard">
            <div className="chartHead">
              <div className="stats">
                <div className="stat">
                  <div className="n" id="statDeals">
                    247
                  </div>
                  <div className="l">Deals learned from</div>
                </div>
                <div className="stat">
                  <div className="n" id="statAcc">
                    91%
                  </div>
                  <div className="l">DealRipe accuracy</div>
                </div>
                <div className="stat">
                  <div className="n">1.9&times;</div>
                  <div className="l">Win lift when prescription is followed</div>
                </div>
              </div>
              <div className="legend">
                <span className="li">
                  <span className="sw" style={{ background: "#22c55e" }} />
                  DealRipe
                </span>
                <span className="li">
                  <span className="sw" style={{ background: "#cbd5e1" }} />
                  Rep commit
                </span>
              </div>
            </div>
            <svg
              className="chart"
              id="chart"
              viewBox="0 0 600 210"
              preserveAspectRatio="none"
            >
              <defs>
                <linearGradient id="g1" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor="#22c55e" stopOpacity="0.28" />
                  <stop offset="1" stopColor="#22c55e" stopOpacity="0" />
                </linearGradient>
              </defs>
              <line className="gridline" x1="40" y1="20" x2="590" y2="20" />
              <line className="gridline" x1="40" y1="70" x2="590" y2="70" />
              <line className="gridline" x1="40" y1="120" x2="590" y2="120" />
              <line className="gridline" x1="40" y1="170" x2="590" y2="170" />
              <text className="axislbl" x="4" y="24">
                100%
              </text>
              <text className="axislbl" x="10" y="124">
                75%
              </text>
              <text className="axislbl" x="10" y="174">
                60%
              </text>
              <path className="area" id="area" d="" />
              <path className="lineRep" id="lineRep" d="" />
              <path className="lineRipe" id="lineRipe" d="" />
              <circle
                className="newdot"
                id="newdot"
                r="4"
                cx="0"
                cy="0"
                style={{ opacity: 0 }}
              />
            </svg>
            <p className="hint">
              X axis: deals learned from, over the last 8 quarters. Each close
              nudges the green line up, with diminishing but never-zero returns.
            </p>
          </div>

          <div className="card sidePanel">
            <div className="eyebrow">What it just learned</div>
            <div className="subtle" style={{ marginTop: 2 }}>
              New rules form as deals close.
            </div>
            <div className="feed" id="feed" />
            <div className="controls">
              <button className="btn primary" id="simBtn">
                ▶ Simulate a deal closing
              </button>
              <button className="btn ghost" id="resetBtn">
                Reset
              </button>
            </div>
            <p className="hint">
              Click during a demo to show the model getting smarter live.
            </p>
          </div>
        </div>
      </section>

      {tiedInsight && (
        <p className="disc">
          Where this shows up on the deal: {tiedInsight}
        </p>
      )}
      <p className="disc">
        Illustrative demo, tuned to show how the engine learns, not a live
        production readout or a performance guarantee. In a live deployment these
        rules and weights are formed from the closed-loop data your pilot
        collects: prescribed actions, adherence, and outcomes on your own deals.
      </p>
    </div>
  );
}
