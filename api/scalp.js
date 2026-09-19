<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1, viewport-fit=cover"
  />

  <meta name="theme-color" content="#0b0e12" />
  <meta name="color-scheme" content="dark" />

  <meta
    name="description"
    content="Institutional Gold Terminal — XAU/USD M15 + M5 scalp intelligence."
  />

  <link rel="manifest" href="/manifest.json" />

  <title>XAU/USD — Institutional Gold Terminal</title>

  <style>
    :root {
      --bg: #07090c;
      --bg2: #0b0e12;
      --panel: #10141a;
      --panel2: #141922;
      --panel3: #0d1117;

      --border: rgba(255,255,255,.08);
      --border2: rgba(212,175,92,.22);

      --text: #f4f1e8;
      --muted: #8f98a5;
      --dim: #5f6875;

      --gold: #d6b15e;
      --gold2: #f0d48a;

      --green: #20c982;
      --green2: #58e0a5;

      --red: #ef5262;
      --red2: #ff7b88;

      --amber: #e9a83b;
      --blue: #5fa8ff;

      --shadow:
        0 18px 50px rgba(0,0,0,.35);

      --radius: 16px;
    }

    * {
      box-sizing: border-box;
    }

    html {
      background: var(--bg);
      scroll-behavior: smooth;
    }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(
          circle at 50% -10%,
          rgba(214,175,94,.09),
          transparent 35%
        ),
        linear-gradient(
          180deg,
          #07090c 0%,
          #090c11 45%,
          #07090c 100%
        );
      color: var(--text);
      font-family:
        Inter,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        Roboto,
        Arial,
        sans-serif;
      -webkit-font-smoothing: antialiased;
    }

    button {
      font: inherit;
    }

    .app {
      width: min(1180px, 100%);
      margin: auto;
      padding:
        max(14px, env(safe-area-inset-top))
        14px
        calc(30px + env(safe-area-inset-bottom));
    }

    /* =========================================================
       TOP BAR
       ========================================================= */

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;

      padding: 14px 2px 18px;

      border-bottom: 1px solid var(--border);
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }

    .brand-mark {
      width: 42px;
      height: 42px;

      border-radius: 12px;

      display: grid;
      place-items: center;

      background:
        linear-gradient(
          145deg,
          rgba(240,212,138,.18),
          rgba(214,175,94,.04)
        );

      border: 1px solid var(--border2);

      color: var(--gold2);
      font-size: 20px;

      box-shadow:
        inset 0 0 20px rgba(214,175,94,.04),
        0 8px 24px rgba(0,0,0,.25);
    }

    .brand h1 {
      margin: 0;
      font-size: 15px;
      letter-spacing: .16em;
      text-transform: uppercase;
      font-weight: 800;
    }

    .brand p {
      margin: 4px 0 0;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: .06em;
    }

    .top-actions {
      display: flex;
      align-items: center;
      gap: 7px;
    }

    .icon-btn {
      width: 40px;
      height: 40px;

      border: 1px solid var(--border);
      border-radius: 11px;

      background: var(--panel);
      color: var(--muted);

      cursor: pointer;
    }

    .icon-btn:hover {
      color: var(--gold2);
      border-color: var(--border2);
    }

    /* =========================================================
       STATUS STRIP
       ========================================================= */

    .status-strip {
      display: grid;
      grid-template-columns:
        repeat(4, minmax(0,1fr));

      gap: 8px;
      margin: 12px 0;
    }

    .status-item {
      min-width: 0;

      padding: 10px 11px;

      border:
        1px solid var(--border);

      border-radius: 12px;

      background:
        linear-gradient(
          180deg,
          rgba(255,255,255,.025),
          rgba(255,255,255,.01)
        );
    }

    .status-label {
      display: block;
      color: var(--dim);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: .12em;
      margin-bottom: 4px;
    }

    .status-value {
      display: flex;
      align-items: center;
      gap: 6px;

      min-width: 0;

      color: var(--text);
      font-size: 11px;
      font-weight: 700;

      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--dim);
      flex: 0 0 auto;
    }

    .dot.live {
      background: var(--green);
      box-shadow: 0 0 9px rgba(32,201,130,.65);
    }

    .dot.warn {
      background: var(--amber);
      box-shadow: 0 0 9px rgba(233,168,59,.55);
    }

    .dot.bad {
      background: var(--red);
      box-shadow: 0 0 9px rgba(239,82,98,.55);
    }

    /* =========================================================
       HERO
       ========================================================= */

    .hero {
      position: relative;
      overflow: hidden;

      border:
        1px solid rgba(214,175,94,.18);

      border-radius: 22px;

      background:
        radial-gradient(
          circle at 80% 20%,
          rgba(214,175,94,.08),
          transparent 35%
        ),
        linear-gradient(
          145deg,
          #11161d,
          #0c1015
        );

      box-shadow: var(--shadow);

      padding: 20px;
    }

    .hero::before {
      content: "";

      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;

      width: 3px;

      background:
        linear-gradient(
          180deg,
          var(--gold2),
          transparent
        );

      opacity: .75;
    }

    .hero-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 20px;
    }

    .instrument {
      color: var(--muted);
      font-size: 10px;
      letter-spacing: .16em;
      text-transform: uppercase;
    }

    .price {
      margin-top: 5px;

      font-size:
        clamp(36px, 8vw, 62px);

      line-height: 1;

      font-weight: 800;
      letter-spacing: -.04em;

      color: var(--text);
    }

    .price-meta {
      margin-top: 9px;

      display: flex;
      align-items: center;
      gap: 8px;

      flex-wrap: wrap;

      color: var(--muted);
      font-size: 11px;
    }

    .source-badge,
    .tiny-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;

      padding: 5px 8px;

      border-radius: 7px;

      border: 1px solid var(--border);

      background: rgba(255,255,255,.025);

      color: var(--muted);

      font-size: 9px;
      font-weight: 800;
      letter-spacing: .08em;
      text-transform: uppercase;
    }

    .hero-signal {
      text-align: right;
      min-width: 120px;
    }

    .signal-caption {
      color: var(--dim);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: .14em;
    }

    .signal {
      margin-top: 6px;

      font-size: 27px;
      font-weight: 900;
      letter-spacing: .08em;
    }

    .signal.buy {
      color: var(--green2);
      text-shadow: 0 0 22px rgba(32,201,130,.18);
    }

    .signal.sell {
      color: var(--red2);
      text-shadow: 0 0 22px rgba(239,82,98,.18);
    }

    .signal.wait {
      color: var(--amber);
    }

    .score-row {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;

      margin-top: 8px;
    }

    .score {
      color: var(--gold2);
      font-size: 12px;
      font-weight: 800;
    }

    /* =========================================================
       HERO GRID
       ========================================================= */

    .hero-grid {
      display: grid;
      grid-template-columns:
        1.25fr .75fr;

      gap: 12px;
      margin-top: 18px;
    }

    .mini-panel {
      border:
        1px solid var(--border);

      background:
        rgba(255,255,255,.018);

      border-radius: 13px;

      padding: 13px;
    }

    .mini-title {
      color: var(--dim);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: .13em;
      margin-bottom: 8px;
    }

    .mini-value {
      font-size: 16px;
      font-weight: 800;
    }

    .mini-sub {
      color: var(--muted);
      font-size: 10px;
      margin-top: 4px;
    }

    /* =========================================================
       MAIN GRID
       ========================================================= */

    .section {
      margin-top: 14px;
    }

    .section-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;

      margin: 22px 2px 9px;
    }

    .section-title {
      display: flex;
      align-items: center;
      gap: 8px;

      font-size: 11px;
      font-weight: 900;

      text-transform: uppercase;
      letter-spacing: .13em;
    }

    .section-title::before {
      content: "";

      width: 3px;
      height: 14px;

      border-radius: 2px;

      background: var(--gold);
    }

    .section-note {
      color: var(--dim);
      font-size: 9px;
      letter-spacing: .06em;
    }

    .grid-3 {
      display: grid;
      grid-template-columns:
        repeat(3, minmax(0,1fr));
      gap: 10px;
    }

    .grid-2 {
      display: grid;
      grid-template-columns:
        repeat(2, minmax(0,1fr));
      gap: 10px;
    }

    .card {
      min-width: 0;

      border:
        1px solid var(--border);

      border-radius: var(--radius);

      background:
        linear-gradient(
          180deg,
          rgba(255,255,255,.025),
          rgba(255,255,255,.012)
        );

      box-shadow:
        0 10px 30px rgba(0,0,0,.12);

      padding: 15px;
    }

    .card.gold {
      border-color: rgba(214,175,94,.20);
    }

    .card-title {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;

      margin-bottom: 14px;
    }

    .card-title strong {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .1em;
    }

    .card-title span {
      color: var(--dim);
      font-size: 9px;
    }

    /* =========================================================
       TIMEFRAME CARDS
       ========================================================= */

    .tf-card {
      position: relative;
      overflow: hidden;
    }

    .tf-card.buy {
      border-color: rgba(32,201,130,.24);
    }

    .tf-card.sell {
      border-color: rgba(239,82,98,.24);
    }

    .tf-card.wait {
      border-color: rgba(233,168,59,.20);
    }

    .tf-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }

    .tf-name {
      font-size: 18px;
      font-weight: 900;
      letter-spacing: .02em;
    }

    .tf-direction {
      padding: 5px 8px;
      border-radius: 7px;

      font-size: 9px;
      font-weight: 900;
      letter-spacing: .1em;

      border: 1px solid var(--border);
    }

    .tf-direction.buy {
      color: var(--green2);
      background: rgba(32,201,130,.07);
      border-color: rgba(32,201,130,.18);
    }

    .tf-direction.sell {
      color: var(--red2);
      background: rgba(239,82,98,.07);
      border-color: rgba(239,82,98,.18);
    }

    .tf-direction.wait {
      color: var(--amber);
      background: rgba(233,168,59,.07);
      border-color: rgba(233,168,59,.18);
    }

    .bar {
      height: 5px;
      margin: 15px 0;

      border-radius: 99px;

      background: #080b0f;
      overflow: hidden;

      display: flex;
      gap: 2px;
    }

    .bar-buy {
      background: var(--green);
      height: 100%;
      transition: width .4s ease;
    }

    .bar-sell {
      background: var(--red);
      height: 100%;
      transition: width .4s ease;
    }

    .tf-score {
      display: flex;
      justify-content: space-between;
      color: var(--muted);
      font-size: 10px;
    }

    .tf-score strong {
      color: var(--text);
    }

    .metrics {
      display: grid;
      grid-template-columns:
        repeat(2, minmax(0,1fr));

      gap: 8px;

      margin-top: 12px;
    }

    .metric {
      padding: 9px;

      border:
        1px solid rgba(255,255,255,.055);

      border-radius: 9px;

      background:
        rgba(0,0,0,.14);
    }

    .metric-label {
      color: var(--dim);
      font-size: 8px;
      text-transform: uppercase;
      letter-spacing: .1em;
    }

    .metric-value {
      margin-top: 4px;

      color: var(--text);
      font-size: 11px;
      font-weight: 800;

      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* =========================================================
       TRADE PLAN
       ========================================================= */

    .trade-plan {
      border:
        1px solid rgba(214,175,94,.24);

      background:
        radial-gradient(
          circle at 100% 0,
          rgba(214,175,94,.08),
          transparent 30%
        ),
        linear-gradient(
          145deg,
          #11161d,
          #0c1015
        );
    }

    .plan-status {
      display: inline-flex;
      align-items: center;
      gap: 7px;

      padding: 7px 10px;

      border-radius: 8px;

      font-size: 9px;
      font-weight: 900;
      letter-spacing: .1em;
      text-transform: uppercase;

      border: 1px solid var(--border);
    }

    .plan-status.ready {
      color: var(--green2);
      border-color: rgba(32,201,130,.22);
      background: rgba(32,201,130,.06);
    }

    .plan-status.blocked {
      color: var(--red2);
      border-color: rgba(239,82,98,.22);
      background: rgba(239,82,98,.06);
    }

    .plan-status.wait {
      color: var(--amber);
      border-color: rgba(233,168,59,.22);
      background: rgba(233,168,59,.06);
    }

    .plan-main {
      display: grid;
      grid-template-columns:
        1.1fr .9fr;

      gap: 16px;
    }

    .entry-box {
      display: flex;
      align-items: baseline;
      gap: 10px;
    }

    .entry-label {
      color: var(--muted);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: .1em;
    }

    .entry-price {
      font-size: 35px;
      font-weight: 900;
      letter-spacing: -.04em;
    }

    .plan-side {
      display: grid;
      grid-template-columns:
        repeat(3,1fr);

      gap: 8px;
    }

    .level {
      padding: 11px 9px;

      border:
        1px solid var(--border);

      border-radius: 10px;

      background: rgba(0,0,0,.15);
    }

    .level small {
      display: block;

      color: var(--dim);
      font-size: 8px;

      text-transform: uppercase;
      letter-spacing: .1em;
    }

    .level strong {
      display: block;
      margin-top: 6px;

      font-size: 14px;
      font-weight: 900;
    }

    .level.sl strong {
      color: var(--red2);
    }

    .level.tp strong {
      color: var(--green2);
    }

    .plan-footer {
      display: flex;
      flex-wrap: wrap;
      gap: 7px;

      margin-top: 14px;
    }

    /* =========================================================
       S/R
       ========================================================= */

    .sr-layout {
      display: grid;
      grid-template-columns:
        repeat(2,minmax(0,1fr));

      gap: 10px;
    }

    .sr-box {
      padding: 16px;

      border-radius: 13px;

      border: 1px solid var(--border);

      background: rgba(0,0,0,.14);
    }

    .sr-box.support {
      border-color: rgba(32,201,130,.18);
    }

    .sr-box.resistance {
      border-color: rgba(239,82,98,.18);
    }

    .sr-label {
      color: var(--dim);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: .12em;
    }

    .sr-price {
      margin-top: 7px;

      font-size: 27px;
      font-weight: 900;
    }

    .support .sr-price {
      color: var(--green2);
    }

    .resistance .sr-price {
      color: var(--red2);
    }

    .sr-distance {
      margin-top: 4px;
      color: var(--muted);
      font-size: 10px;
    }

    .sr-position {
      margin-top: 12px;

      padding: 10px;

      border:
        1px solid var(--border);

      border-radius: 9px;

      background: rgba(255,255,255,.018);

      color: var(--text);

      font-size: 10px;
      font-weight: 800;

      text-transform: uppercase;
      letter-spacing: .07em;
    }

    /* =========================================================
       HOLD / CONTEXT
       ========================================================= */

    .hold-card {
      display: grid;
      grid-template-columns:
        1fr auto;

      align-items: center;
      gap: 15px;
    }

    .hold-big {
      font-size: 25px;
      font-weight: 900;
    }

    .hold-big.buy {
      color: var(--green2);
    }

    .hold-big.sell {
      color: var(--red2);
    }

    .hold-big.neutral {
      color: var(--amber);
    }

    .hold-permission {
      color: var(--muted);
      font-size: 10px;
      margin-top: 5px;
    }

    .context-pill {
      padding: 10px 12px;

      border-radius: 10px;

      border: 1px solid var(--border);

      color: var(--gold2);

      font-size: 10px;
      font-weight: 900;
      letter-spacing: .08em;
    }

    /* =========================================================
       ROADBLOCK
       ========================================================= */

    .roadblock {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;

      padding: 12px 13px;

      border:
        1px solid var(--border);

      border-radius: 11px;

      background: rgba(0,0,0,.14);
    }

    .roadblock-left {
      min-width: 0;
    }

    .roadblock-name {
      color: var(--muted);
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: .1em;
    }

    .roadblock-price {
      margin-top: 4px;
      font-size: 15px;
      font-weight: 900;
    }

    .roadblock-clear {
      color: var(--green2);
    }

    .roadblock-warning {
      color: var(--amber);
    }

    /* =========================================================
       SETUP
       ========================================================= */

    .setup {
      display: grid;
      grid-template-columns:
        repeat(2,minmax(0,1fr));

      gap: 10px;
    }

    .setup-box {
      border:
        1px solid var(--border);

      border-radius: 12px;

      padding: 14px;

      background: rgba(0,0,0,.13);
    }

    .setup-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .setup-dir {
      font-size: 12px;
      font-weight: 900;
      letter-spacing: .1em;
    }

    .setup-dir.buy {
      color: var(--green2);
    }

    .setup-dir.sell {
      color: var(--red2);
    }

    .setup-type {
      color: var(--gold2);
      font-size: 9px;
      font-weight: 800;
    }

    .setup-list {
      margin: 12px 0 0;
      padding: 0;

      list-style: none;
    }

    .setup-list li {
      display: flex;
      justify-content: space-between;
      gap: 12px;

      padding: 8px 0;

      border-bottom:
        1px solid rgba(255,255,255,.045);

      color: var(--muted);

      font-size: 10px;
    }

    .setup-list li:last-child {
      border-bottom: 0;
    }

    .setup-list b {
      color: var(--text);
      text-align: right;
    }

    /* =========================================================
       REASONS
       ========================================================= */

    .reasons {
      display: grid;
      gap: 6px;
    }

    .reason {
      display: flex;
      align-items: flex-start;
      gap: 8px;

      padding: 9px 10px;

      border:
        1px solid rgba(255,255,255,.045);

      border-radius: 9px;

      background: rgba(0,0,0,.13);

      color: var(--muted);
      font-size: 10px;
      line-height: 1.4;
    }

    .reason::before {
      content: "•";
      color: var(--gold);
      font-weight: 900;
    }

    /* =========================================================
       CHART
       ========================================================= */

    .chart-wrap {
      position: relative;

      height: 260px;

      border:
        1px solid var(--border);

      border-radius: 13px;

      overflow: hidden;

      background:
        linear-gradient(
          180deg,
          #0b0f14,
          #080b0f
        );
    }

    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }

    .chart-overlay {
      position: absolute;

      top: 10px;
      left: 10px;

      display: flex;
      gap: 6px;

      pointer-events: none;
    }

    /* =========================================================
       DIAGNOSTICS
       ========================================================= */

    .diagnostics {
      display: grid;
      grid-template-columns:
        repeat(4,minmax(0,1fr));

      gap: 7px;
    }

    .diag {
      padding: 10px;

      border:
        1px solid rgba(255,255,255,.05);

      border-radius: 9px;

      background: rgba(0,0,0,.13);
    }

    .diag-label {
      color: var(--dim);
      font-size: 8px;
      text-transform: uppercase;
      letter-spacing: .1em;
    }

    .diag-value {
      margin-top: 5px;

      color: var(--text);
      font-size: 10px;
      font-weight: 800;

      word-break: break-word;
    }

    /* =========================================================
       PUSH
       ========================================================= */

    .push-card {
      display: flex;
      align-items: center;
      justify-content: space-between;

      gap: 15px;
    }

    .push-copy strong {
      display: block;

      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: .1em;
    }

    .push-copy p {
      margin: 5px 0 0;

      color: var(--muted);
      font-size: 10px;
      line-height: 1.45;
    }

    .push-btn {
      border: 0;

      padding: 11px 15px;

      border-radius: 10px;

      cursor: pointer;

      color: #080a0d;

      background:
        linear-gradient(
          135deg,
          var(--gold2),
          var(--gold)
        );

      font-size: 10px;
      font-weight: 900;
      letter-spacing: .08em;
      text-transform: uppercase;

      white-space: nowrap;
    }

    .push-btn:disabled {
      opacity: .5;
      cursor: not-allowed;
    }

    .push-status {
      margin-top: 8px;

      color: var(--dim);
      font-size: 9px;
    }

    /* =========================================================
       FOOTER
       ========================================================= */

    footer {
      padding: 28px 3px 10px;

      text-align: center;

      color: var(--dim);

      font-size: 9px;
      line-height: 1.6;

      letter-spacing: .04em;
    }

    /* =========================================================
       TOAST
       ========================================================= */

    .toast {
      position: fixed;

      left: 50%;
      bottom:
        calc(
          18px +
          env(safe-area-inset-bottom)
        );

      transform:
        translate(-50%, 20px);

      opacity: 0;

      pointer-events: none;

      z-index: 9999;

      max-width:
        min(92vw, 420px);

      padding: 11px 14px;

      border:
        1px solid var(--border2);

      border-radius: 10px;

      background: #11161d;

      color: var(--text);

      box-shadow: var(--shadow);

      font-size: 10px;
      font-weight: 700;

      transition:
        opacity .2s ease,
        transform .2s ease;
    }

    .toast.show {
      opacity: 1;
      transform:
        translate(-50%, 0);
    }

    /* =========================================================
       RESPONSIVE
       ========================================================= */

    @media (max-width: 820px) {
      .grid-3 {
        grid-template-columns:
          1fr;
      }

      .hero-grid {
        grid-template-columns:
          1fr 1fr;
      }

      .plan-main {
        grid-template-columns:
          1fr;
      }

      .diagnostics {
        grid-template-columns:
          repeat(2,1fr);
      }
    }

    @media (max-width: 620px) {
      .app {
        padding-left: 10px;
        padding-right: 10px;
      }

      .topbar {
        align-items: flex-start;
      }

      .brand-mark {
        width: 38px;
        height: 38px;
      }

      .brand h1 {
        font-size: 12px;
      }

      .brand p {
        font-size: 9px;
      }

      .status-strip {
        grid-template-columns:
          repeat(2,1fr);
      }

      .hero {
        padding: 16px;
        border-radius: 18px;
      }

      .hero-top {
        flex-direction: column;
      }

      .hero-signal {
        width: 100%;
        text-align: left;
      }

      .score-row {
        justify-content: flex-start;
      }

      .hero-grid {
        grid-template-columns:
          1fr;
      }

      .sr-layout,
      .setup {
        grid-template-columns:
          1fr;
      }

      .plan-side {
        grid-template-columns:
          repeat(3,1fr);
      }

      .hold-card {
        grid-template-columns:
          1fr;
      }

      .context-pill {
        width: fit-content;
      }

      .push-card {
        align-items: flex-start;
        flex-direction: column;
      }

      .push-btn {
        width: 100%;
      }

      .chart-wrap {
        height: 220px;
      }
    }
  </style>
</head>

<body>

<div class="app">

  <!-- =======================================================
       TOP
       ======================================================== -->

  <header class="topbar">

    <div class="brand">

      <div class="brand-mark">
        ✦
      </div>

      <div>
        <h1>Institutional Gold Terminal</h1>
        <p>
          XAU/USD · M15 confirmation · M5 trigger · H1 context
        </p>
      </div>

    </div>

    <div class="top-actions">

      <button
        class="icon-btn"
        id="refreshBtn"
        title="Refresh"
      >
        ↻
      </button>

    </div>

  </header>

  <!-- =======================================================
       STATUS
       ======================================================== -->

  <section class="status-strip">

    <div class="status-item">
      <span class="status-label">System</span>
      <span class="status-value">
        <i class="dot" id="systemDot"></i>
        <span id="systemStatus">Starting</span>
      </span>
    </div>

    <div class="status-item">
      <span class="status-label">Market Data</span>
      <span class="status-value">
        <i class="dot" id="apiDot"></i>
        <span id="apiStatus">Checking</span>
      </span>
    </div>

    <div class="status-item">
      <span class="status-label">Signal</span>
      <span class="status-value">
        <i class="dot" id="signalDot"></i>
        <span id="signalStatus">WAIT</span>
      </span>
    </div>

    <div class="status-item">
      <span class="status-label">MYT</span>
      <span class="status-value" id="clock">
        --
      </span>
    </div>

  </section>

  <!-- =======================================================
       HERO
       ======================================================== -->

  <section class="hero">

    <div class="hero-top">

      <div>

        <div class="instrument">
          XAU / USD · SPOT GOLD
        </div>

        <div
          class="price"
          id="price"
        >
          --
        </div>

        <div class="price-meta">

          <span
            class="source-badge"
            id="sourceBadge"
          >
            DATA --
          </span>

          <span id="priceAge">
            --
          </span>

          <span>•</span>

          <span id="lastUpdate">
            --
          </span>

        </div>

      </div>

      <div class="hero-signal">

        <div class="signal-caption">
          SCALP SIGNAL
        </div>

        <div
          class="signal wait"
          id="heroSignal"
        >
          WAIT
        </div>

        <div class="score-row">

          <span class="score">
            SCORE
            <span id="heroScore">0</span>/100
          </span>

        </div>

      </div>

    </div>

    <div class="hero-grid">

      <div class="mini-panel">

        <div class="mini-title">
          Execution
        </div>

        <div
          class="mini-value"
          id="execution"
        >
          WAIT
        </div>

        <div
          class="mini-sub"
          id="setupType"
        >
          NO ALIGNMENT
        </div>

      </div>

      <div class="mini-panel">

        <div class="mini-title">
          Context
        </div>

        <div
          class="mini-value"
          id="context"
        >
          NEUTRAL
        </div>

        <div
          class="mini-sub"
          id="holdPermission"
        >
          NO HOLD
        </div>

      </div>

    </div>

  </section>

  <!-- =======================================================
       TIMEFRAME ENGINE
       ======================================================== -->

  <section class="section">

    <div class="section-head">

      <div class="section-title">
        Timeframe Engine
      </div>

      <div class="section-note">
        M15 → M5 alignment
      </div>

    </div>

    <div class="grid-3">

      <!-- H1 -->

      <article
        class="card tf-card"
        id="h1Card"
      >

        <div class="tf-top">

          <div class="tf-name">
            H1
          </div>

          <div
            class="tf-direction wait"
            id="h1Direction"
          >
            WAIT
          </div>

        </div>

        <div class="bar">
          <div
            class="bar-buy"
            id="h1Bar"
            style="width:50%"
          ></div>
        </div>

        <div class="tf-score">

          <span>
            HOLD BIAS
          </span>

          <strong id="h1HoldBias">
            NEUTRAL
          </strong>

        </div>

        <div class="metrics">

          <div class="metric">
            <div class="metric-label">
              EMA50
            </div>
            <div
              class="metric-value"
              id="h1Ema50"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              EMA200
            </div>
            <div
              class="metric-value"
              id="h1Ema200"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              ATR
            </div>
            <div
              class="metric-value"
              id="h1Atr"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              Permission
            </div>
            <div
              class="metric-value"
              id="h1Permission"
            >
              NO HOLD
            </div>
          </div>

        </div>

      </article>

      <!-- M15 -->

      <article
        class="card tf-card"
        id="m15Card"
      >

        <div class="tf-top">

          <div class="tf-name">
            M15
          </div>

          <div
            class="tf-direction wait"
            id="m15Direction"
          >
            WAIT
          </div>

        </div>

        <div class="bar">

          <div
            class="bar-buy"
            id="m15BuyBar"
            style="width:0%"
          ></div>

          <div
            class="bar-sell"
            id="m15SellBar"
            style="width:0%"
          ></div>

        </div>

        <div class="tf-score">

          <span>
            BUY
            <strong id="m15Buy">
              0
            </strong>
          </span>

          <span>
            SELL
            <strong id="m15Sell">
              0
            </strong>
          </span>

        </div>

        <div class="metrics">

          <div class="metric">
            <div class="metric-label">
              EMA20
            </div>
            <div
              class="metric-value"
              id="m15Ema20"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              EMA50
            </div>
            <div
              class="metric-value"
              id="m15Ema50"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              RSI
            </div>
            <div
              class="metric-value"
              id="m15Rsi"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              BOS
            </div>
            <div
              class="metric-value"
              id="m15Bos"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              CHOCH
            </div>
            <div
              class="metric-value"
              id="m15Choch"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              Momentum
            </div>
            <div
              class="metric-value"
              id="m15Momentum"
            >
              --
            </div>
          </div>

        </div>

      </article>

      <!-- M5 -->

      <article
        class="card tf-card"
        id="m5Card"
      >

        <div class="tf-top">

          <div class="tf-name">
            M5
          </div>

          <div
            class="tf-direction wait"
            id="m5Direction"
          >
            WAIT
          </div>

        </div>

        <div class="bar">

          <div
            class="bar-buy"
            id="m5BuyBar"
            style="width:0%"
          ></div>

          <div
            class="bar-sell"
            id="m5SellBar"
            style="width:0%"
          ></div>

        </div>

        <div class="tf-score">

          <span>
            BUY
            <strong id="m5Buy">
              0
            </strong>
          </span>

          <span>
            SELL
            <strong id="m5Sell">
              0
            </strong>
          </span>

        </div>

        <div class="metrics">

          <div class="metric">
            <div class="metric-label">
              EMA9
            </div>
            <div
              class="metric-value"
              id="m5Ema9"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              EMA20
            </div>
            <div
              class="metric-value"
              id="m5Ema20"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              RSI
            </div>
            <div
              class="metric-value"
              id="m5Rsi"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              BOS
            </div>
            <div
              class="metric-value"
              id="m5Bos"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              CHOCH
            </div>
            <div
              class="metric-value"
              id="m5Choch"
            >
              --
            </div>
          </div>

          <div class="metric">
            <div class="metric-label">
              Momentum
            </div>
            <div
              class="metric-value"
              id="m5Momentum"
            >
              --
            </div>
          </div>

        </div>

      </article>

    </div>

  </section>

  <!-- =======================================================
       TRADE PLAN
       ======================================================== -->

  <section class="section">

    <div class="section-head">

      <div class="section-title">
        Fixed Trade Plan
      </div>

      <div
        class="section-note"
        id="planSource"
      >
        NO PLAN
      </div>

    </div>

    <article class="card trade-plan">

      <div class="card-title">

        <strong>
          Execution Matrix
        </strong>

        <div
          class="plan-status wait"
          id="planStatus"
        >
          WAIT
        </div>

      </div>

      <div class="plan-main">

        <div>

          <div class="entry-box">

            <span class="entry-label">
              Entry
            </span>

            <span
              class="entry-price"
              id="entry"
            >
              --
            </span>

          </div>

          <div class="plan-footer">

            <span
              class="tiny-badge"
              id="planSetup"
            >
              NO SETUP
            </span>

            <span
              class="tiny-badge"
              id="planRR"
            >
              RR --
            </span>

            <span
              class="tiny-badge"
              id="planRisk"
            >
              RISK --
            </span>

          </div>

        </div>

        <div class="plan-side">

          <div class="level sl">

            <small>
              Stop Loss
            </small>

            <strong id="sl">
              --
            </strong>

          </div>

          <div class="level tp">

            <small>
              TP1
            </small>

            <strong id="tp1">
              --
            </strong>

          </div>

          <div class="level tp">

            <small>
              TP2
            </small>

            <strong id="tp2">
              --
            </strong>

          </div>

        </div>

      </div>

      <div class="plan-footer">

        <span
          class="tiny-badge"
          id="tp3Badge"
        >
          TP3 --
        </span>

        <span
          class="tiny-badge"
          id="targetBadge"
        >
          H1 TARGET --
        </span>

        <span
          class="tiny-badge"
          id="targetValidBadge"
        >
          TARGET --
        </span>

        <span
          class="tiny-badge"
          id="lockedBadge"
        >
          NOT LOCKED
        </span>

      </div>

    </article>

  </section>

  <!-- =======================================================
       H1 S/R
       ======================================================== -->

  <section class="section">

    <div class="section-head">

      <div class="section-title">
        H1 Structural Map
      </div>

      <div
        class="section-note"
        id="srContext"
      >
        --
      </div>

    </div>

    <div class="sr-layout">

      <article class="card sr-box support">

        <div class="sr-label">
          H1 Support
        </div>

        <div
          class="sr-price"
          id="support"
        >
          --
        </div>

        <div
          class="sr-distance"
          id="supportDistance"
        >
          --
        </div>

        <div
          class="sr-position"
          id="buyFilter"
        >
          BUY FILTER --
        </div>

      </article>

      <article class="card sr-box resistance">

        <div class="sr-label">
          H1 Resistance
        </div>

        <div
          class="sr-price"
          id="resistance"
        >
          --
        </div>

        <div
          class="sr-distance"
          id="resistanceDistance"
        >
          --
        </div>

        <div
          class="sr-position"
          id="sellFilter"
        >
          SELL FILTER --
        </div>

      </article>

    </div>

  </section>

  <!-- =======================================================
       HOLD
       ======================================================== -->

  <section class="section">

    <div class="section-head">

      <div class="section-title">
        H1 Hold Context
      </div>

      <div class="section-note">
        Context only
      </div>

    </div>

    <article class="card hold-card">

      <div>

        <div
          class="hold-big neutral"
          id="holdBias"
        >
          NEUTRAL
        </div>

        <div
          class="hold-permission"
          id="holdText"
        >
          H1 is context for holding; M15 + M5 drive scalp entry.
        </div>

      </div>

      <div
        class="context-pill"
        id="contextPill"
      >
        NEUTRAL
      </div>

    </article>

  </section>

  <!-- =======================================================
       ROADBLOCK
       ======================================================== -->

  <section class="section">

    <div class="section-head">

      <div class="section-title">
        Target Roadblock
      </div>

      <div class="section-note">
        M15 / M5
      </div>

    </div>

    <article class="card">

      <div
        class="roadblock"
        id="roadblockBox"
      >

        <div class="roadblock-left">

          <div class="roadblock-name">
            Nearest obstacle
          </div>

          <div
            class="roadblock-price roadblock-clear"
            id="roadblockPrice"
          >
            CLEAR
          </div>

        </div>

        <span
          class="tiny-badge"
          id="roadblockBadge"
        >
          NO ROADBLOCK
        </span>

      </div>

    </article>

  </section>

  <!-- =======================================================
       SETUP ANALYSIS
       ======================================================== -->

  <section class="section">

    <div class="section-head">

      <div class="section-title">
        Setup Analysis
      </div>

      <div class="section-note">
        Continuation / reversal
      </div>

    </div>

    <div class="setup">

      <article class="setup-box">

        <div class="setup-head">

          <div
            class="setup-dir buy"
          >
            BUY
          </div>

          <div
            class="setup-type"
            id="buySetupType"
          >
            NONE
          </div>

        </div>

        <ul class="setup-list">

          <li>
            <span>Aligned</span>
            <b id="buyAligned">NO</b>
          </li>

          <li>
            <span>Continuation</span>
            <b id="buyContinuation">NO</b>
          </li>

          <li>
            <span>Reversal</span>
            <b id="buyReversal">NO</b>
          </li>

          <li>
            <span>Location</span>
            <b id="buyLocation">--</b>
          </li>

          <li>
            <span>H1 Bias</span>
            <b id="buyH1Bias">--</b>
          </li>

          <li>
            <span>Target</span>
            <b id="buyTarget">--</b>
          </li>

        </ul>

      </article>

      <article class="setup-box">

        <div class="setup-head">

          <div
            class="setup-dir sell"
          >
            SELL
          </div>

          <div
            class="setup-type"
            id="sellSetupType"
          >
            NONE
          </div>

        </div>

        <ul class="setup-list">

          <li>
            <span>Aligned</span>
            <b id="sellAligned">NO</b>
          </li>

          <li>
            <span>Continuation</span>
            <b id="sellContinuation">NO</b>
          </li>

          <li>
            <span>Reversal</span>
            <b id="sellReversal">NO</b>
          </li>

          <li>
            <span>Location</span>
            <b id="sellLocation">--</b>
          </li>

          <li>
            <span>H1 Bias</span>
            <b id="sellH1Bias">--</b>
          </li>

          <li>
            <span>Target</span>
            <b id="sellTarget">--</b>
          </li>

        </ul>

      </article>

    </div>

  </section>

  <!-- =======================================================
       REASONS
       ======================================================== -->

  <section class="section">

    <div class="section-head">

      <div class="section-title">
        Signal Intelligence
      </div>

      <div class="section-note">
        Engine reasoning
      </div>

    </div>

    <article class="card">

      <div
        class="reasons"
        id="reasons"
      >

        <div class="reason">
          Waiting for market data...
        </div>

      </div>

    </article>

  </section>

  <!-- =======================================================
       CHART
       ======================================================== -->

  <section class="section">

    <div class="section-head">

      <div class="section-title">
        M5 Price Structure
      </div>

      <div
        class="section-note"
        id="chartInfo"
      >
        Last 60 candles
      </div>

    </div>

    <article class="chart-wrap">

      <div class="chart-overlay">

        <span class="tiny-badge">
          M5
        </span>

        <span
          class="tiny-badge"
          id="chartSignal"
        >
          WAIT
        </span>

      </div>

      <canvas id="chart"></canvas>

    </article>

  </section>

  <!-- =======================================================
       DIAGNOSTICS
       ======================================================== -->

  <section class="section">

    <div class="section-head">

      <div class="section-title">
        Diagnostics
      </div>

      <div class="section-note">
        Data integrity
      </div>

    </div>

    <article class="card">

      <div class="diagnostics">

        <div class="diag">
          <div class="diag-label">
            M5 Candles
          </div>
          <div
            class="diag-value"
            id="diagM5"
          >
            --
          </div>
        </div>

        <div class="diag">
          <div class="diag-label">
            M15 Candles
          </div>
          <div
            class="diag-value"
            id="diagM15"
          >
            --
          </div>
        </div>

        <div class="diag">
          <div class="diag-label">
            H1 Candles
          </div>
          <div
            class="diag-value"
            id="diagH1"
          >
            --
          </div>
        </div>

        <div class="diag">
          <div class="diag-label">
            Data Source
          </div>
          <div
            class="diag-value"
            id="diagSource"
          >
            --
          </div>
        </div>

        <div class="diag">
          <div class="diag-label">
            M5 Cache
          </div>
          <div
            class="diag-value"
            id="diagCacheM5"
          >
            --
          </div>
        </div>

        <div class="diag">
          <div class="diag-label">
            M15 Cache
          </div>
          <div
            class="diag-value"
            id="diagCacheM15"
          >
            --
          </div>
        </div>

        <div class="diag">
          <div class="diag-label">
            H1 Cache
          </div>
          <div
            class="diag-value"
            id="diagCacheH1"
          >
            --
          </div>
        </div>

        <div class="diag">
          <div class="diag-label">
            Signal Candle
          </div>
          <div
            class="diag-value"
            id="diagCandle"
          >
            --
          </div>
        </div>

      </div>

    </article>

  </section>

  <!-- =======================================================
       PUSH
       ======================================================== -->

  <section class="section">

    <div class="section-head">

      <div class="section-title">
        Server Push
      </div>

      <div class="section-note">
        Background alerts
      </div>

    </div>

    <article class="card">

      <div class="push-card">

        <div class="push-copy">

          <strong>
            XAU/USD Entry Alerts
          </strong>

          <p>
            Receive BUY / SELL entry alerts from the server
            even when the dashboard is not open.
          </p>

          <div
            class="push-status"
            id="pushStatus"
          >
            Push not enabled.
          </div>

        </div>

        <button
          class="push-btn"
          id="pushBtn"
        >
          ENABLE PUSH
        </button>

      </div>

    </article>

  </section>

  <footer>

    INSTITUTIONAL GOLD TERMINAL<br />

    M15 + M5 alignment drives scalp signal.
    H1 provides hold/context and structural target.

    <br /><br />

    Data source: Twelve Data · Cache: Redis + local

  </footer>

</div>

<div
  class="toast"
  id="toast"
>
  --
</div>

<script>
"use strict";

/* ============================================================
   CONFIG
   ============================================================ */

const API = "/api/scalp";

const REFRESH_MS = 15000;

let lastData = null;
let refreshTimer = null;

let pushRegistration = null;

/* ============================================================
   HELPERS
   ============================================================ */

const $ = id =>
  document.getElementById(id);

function text(id, value) {
  const el = $(id);
  if (el) el.textContent = value ?? "--";
}

function num(value, digits = 2) {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return "--";
  }

  return Number(value).toFixed(digits);
}

function yesNo(value) {
  return value ? "YES" : "NO";
}

function directionClass(value) {
  const v = String(value || "").toUpperCase();

  if (v === "BUY") return "buy";
  if (v === "SELL") return "sell";

  return "wait";
}

function toast(message) {
  const el = $("toast");

  el.textContent = message;
  el.classList.add("show");

  clearTimeout(toast.timer);

  toast.timer = setTimeout(() => {
    el.classList.remove("show");
  }, 2800);
}

function setDot(id, state) {
  const el = $(id);

  el.className = "dot";

  if (state === "live") {
    el.classList.add("live");
  } else if (state === "warn") {
    el.classList.add("warn");
  } else if (state === "bad") {
    el.classList.add("bad");
  }
}

/* ============================================================
   CLOCK
   ============================================================ */

function updateClock() {
  const now = new Date();

  const formatter =
    new Intl.DateTimeFormat(
      "en-MY",
      {
        timeZone: "Asia/Kuala_Lumpur",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }
    );

  text("clock", formatter.format(now));
}

setInterval(updateClock, 1000);
updateClock();

/* ============================================================
   GENERIC DIRECTION UI
   ============================================================ */

function setDirection(id, value) {
  const el = $(id);

  el.textContent = value || "WAIT";

  el.classList.remove(
    "buy",
    "sell",
    "wait"
  );

  el.classList.add(
    directionClass(value)
  );
}

function setCardDirection(id, value) {
  const el = $(id);

  el.classList.remove(
    "buy",
    "sell",
    "wait"
  );

  el.classList.add(
    directionClass(value)
  );
}

/* ============================================================
   API FETCH
   ============================================================ */

async function loadData() {

  try {

    text(
      "systemStatus",
      "Updating"
    );

    setDot(
      "systemDot",
      "warn"
    );

    const response =
      await fetch(
        `${API}?ts=${Date.now()}`,
        {
          cache: "no-store",
          headers: {
            "cache-control": "no-cache"
          }
        }
      );

    const data =
      await response.json();

    if (
      !response.ok ||
      data?.ok === false
    ) {
      throw new Error(
        data?.error ||
        `HTTP ${response.status}`
      );
    }

    lastData = data;

    render(data);

    text(
      "systemStatus",
      "Online"
    );

    setDot(
      "systemDot",
      "live"
    );

    text(
      "apiStatus",
      data.stale
        ? "CACHE"
        : "LIVE"
    );

    setDot(
      "apiDot",
      data.stale
        ? "warn"
        : "live"
    );

  } catch (error) {

    console.error(
      "Dashboard API error:",
      error
    );

    text(
      "systemStatus",
      "API Error"
    );

    text(
      "apiStatus",
      "ERROR"
    );

    setDot(
      "systemDot",
      "bad"
    );

    setDot(
      "apiDot",
      "bad"
    );
  }
}

/* ============================================================
   RENDER
   ============================================================ */

function render(d) {

  const live =
    d.livePrice ||
    {};

  const price =
    Number(
      live.price ??
      d.price
    );

  const signal =
    String(
      d.signal ||
      "WAIT"
    ).toUpperCase();

  const score =
    Number(
      d.score || 0
    );

  const h1 =
    d.h1 ||
    {};

  const m15 =
    d.m15 ||
    {};

  const m5 =
    d.m5 ||
    {};

  const plan =
    d.tradePlan ||
    {};

  const sr =
    d.srAnalysis ||
    {};

  const setup =
    d.setupAnalysis ||
    {};

  const roadblocks =
    d.roadblocks ||
    {};

  /* ========================================================
     HERO
     ======================================================== */

  text(
    "price",
    Number.isFinite(price)
      ? price.toFixed(2)
      : "--"
  );

  const source =
    live.source ||
    d.dataSource ||
    "UNKNOWN";

  text(
    "sourceBadge",
    `DATA ${source}`
  );

  text(
    "priceAge",
    live.ageSeconds != null
      ? `${live.ageSeconds}s age`
      : "--"
  );

  text(
    "lastUpdate",
    d.timestamp
      ? new Date(d.timestamp)
          .toLocaleTimeString(
            "en-MY",
            {
              hour12: false
            }
          )
      : "--"
  );

  setDirection(
    "heroSignal",
    signal
  );

  text(
    "heroScore",
    score
  );

  text(
    "execution",
    d.execution ||
    "WAIT"
  );

  text(
    "setupType",
    d.setupType ||
    "NO ALIGNMENT"
  );

  text(
    "context",
    d.context ||
    "NEUTRAL"
  );

  text(
    "holdPermission",
    h1.holdPermission ||
    "NO HOLD"
  );

  /* ========================================================
     SIGNAL DOT
     ======================================================== */

  text(
    "signalStatus",
    signal
  );

  setDot(
    "signalDot",
    signal === "BUY" ||
    signal === "SELL"
      ? "live"
      : "warn"
  );

  /* ========================================================
     H1
     ======================================================== */

  setDirection(
    "h1Direction",
    h1.direction
  );

  setCardDirection(
    "h1Card",
    h1.direction
  );

  text(
    "h1HoldBias",
    h1.holdBias ||
    "NEUTRAL"
  );

  text(
    "h1Ema50",
    num(h1.ema50)
  );

  text(
    "h1Ema200",
    num(h1.ema200)
  );

  text(
    "h1Atr",
    num(h1.atr)
  );

  text(
    "h1Permission",
    h1.holdPermission ||
    "NO HOLD"
  );

  const h1Direction =
    String(
      h1.direction ||
      "WAIT"
    ).toUpperCase();

  const h1Bar =
    $("h1Bar");

  if (h1Direction === "BUY") {
    h1Bar.style.width = "100%";
  } else if (h1Direction === "SELL") {
    h1Bar.style.width = "20%";
  } else {
    h1Bar.style.width = "50%";
  }

  /* ========================================================
     M15
     ======================================================== */

  setDirection(
    "m15Direction",
    m15.confirmation ||
    m15.direction
  );

  setCardDirection(
    "m15Card",
    m15.confirmation ||
    m15.direction
  );

  text(
    "m15Buy",
    Math.round(
      m15.buyScore || 0
    )
  );

  text(
    "m15Sell",
    Math.round(
      m15.sellScore || 0
    )
  );

  $("m15BuyBar").style.width =
    `${Math.min(
      100,
      Number(m15.buyScore || 0)
    )}%`;

  $("m15SellBar").style.width =
    `${Math.min(
      100,
      Number(m15.sellScore || 0)
    )}%`;

  text(
    "m15Ema20",
    num(m15.ema20)
  );

  text(
    "m15Ema50",
    num(m15.ema50)
  );

  text(
    "m15Rsi",
    num(m15.rsi, 1)
  );

  text(
    "m15Bos",
    boolSignal(m15.bos)
  );

  text(
    "m15Choch",
    boolSignal(m15.choch)
  );

  text(
    "m15Momentum",
    momentumText(
      m15.momentum
    )
  );

  /* ========================================================
     M5
     ======================================================== */

  setDirection(
    "m5Direction",
    m5.trigger ||
    m5.confirmation
  );

  setCardDirection(
    "m5Card",
    m5.trigger ||
    m5.confirmation
  );

  text(
    "m5Buy",
    Math.round(
      m5.buyScore || 0
    )
  );

  text(
    "m5Sell",
    Math.round(
      m5.sellScore || 0
    )
  );

  $("m5BuyBar").style.width =
    `${Math.min(
      100,
      Number(m5.buyScore || 0)
    )}%`;

  $("m5SellBar").style.width =
    `${Math.min(
      100,
      Number(m5.sellScore || 0)
    )}%`;

  text(
    "m5Ema9",
    num(m5.ema9)
  );

  text(
    "m5Ema20",
    num(m5.ema20)
  );

  text(
    "m5Rsi",
    num(m5.rsi, 1)
  );

  text(
    "m5Bos",
    boolSignal(m5.bos)
  );

  text(
    "m5Choch",
    boolSignal(m5.choch)
  );

  text(
    "m5Momentum",
    momentumText(
      m5.momentum
    )
  );

  /* ========================================================
     TRADE PLAN
     ======================================================== */

  const planReady =
    d.status === "ENTRY" &&
    d.execution === "READY";

  const planBlocked =
    d.execution === "BLOCKED";

  const planStatus =
    $("planStatus");

  planStatus.className =
    "plan-status";

  if (planReady) {
    planStatus.classList.add(
      "ready"
    );

    planStatus.textContent =
      signal === "BUY"
        ? "BUY READY"
        : "SELL READY";

  } else if (planBlocked) {

    planStatus.classList.add(
      "blocked"
    );

    planStatus.textContent =
      "BLOCKED";

  } else {

    planStatus.classList.add(
      "wait"
    );

    planStatus.textContent =
      "WAIT";
  }

  text(
    "entry",
    num(plan.entry)
  );

  text(
    "sl",
    num(plan.stopLoss)
  );

  text(
    "tp1",
    num(plan.tp1)
  );

  text(
    "tp2",
    num(plan.tp2)
  );

  text(
    "tp3Badge",
    `TP3 ${num(plan.tp3)}`
  );

  text(
    "planRR",
    `RR ${plan.rr || "--"}`
  );

  text(
    "planRisk",
    `RISK ${num(plan.risk)}`
  );

  text(
    "planSetup",
    d.setupType ||
    "NO SETUP"
  );

  text(
    "planSource",
    plan.source ||
    "NO PLAN"
  );

  text(
    "targetBadge",
    plan.targetSR != null
      ? `${plan.targetSRType || "H1 TARGET"} ${num(plan.targetSR)}`
      : "H1 TARGET --"
  );

  text(
    "targetValidBadge",
    plan.targetSRValid
      ? "TARGET VALID"
      : "TARGET INVALID"
  );

  text(
    "lockedBadge",
    plan.locked
      ? "REDIS LOCKED"
      : "NOT LOCKED"
  );

  /* ========================================================
     S/R
     ======================================================== */

  const support =
    sr.support?.price;

  const resistance =
    sr.resistance?.price;

  text(
    "support",
    num(support)
  );

  text(
    "resistance",
    num(resistance)
  );

  text(
    "supportDistance",
    sr.supportDistance != null
      ? `${num(sr.supportDistance)} points`
      : "--"
  );

  text(
    "resistanceDistance",
    sr.resistanceDistance != null
      ? `${num(sr.resistanceDistance)} points`
      : "--"
  );

  text(
    "srContext",
    sr.signalContext ||
    sr.position ||
    "--"
  );

  text(
    "buyFilter",
    sr.buyAllowed
      ? "BUY FILTER: OPEN"
      : "BUY FILTER: BLOCKED"
  );

  text(
    "sellFilter",
    sr.sellAllowed
      ? "SELL FILTER: OPEN"
      : "SELL FILTER: BLOCKED"
  );

  /* ========================================================
     HOLD
     ======================================================== */

  const holdBias =
    String(
      h1.holdBias ||
      "NEUTRAL"
    ).toUpperCase();

  const holdEl =
    $("holdBias");

  holdEl.className =
    "hold-big " +
    directionClass(
      holdBias
    );

  holdEl.textContent =
    holdBias;

  text(
    "holdText",
    `${h1.holdPermission || "NO HOLD"} · H1 is context; M15 + M5 drive scalp entry.`
  );

  text(
    "contextPill",
    d.context ||
    "NEUTRAL"
  );

  /* ========================================================
     ROADBLOCK
     ======================================================== */

  const nearest =
    roadblocks.nearest ||
    null;

  if (nearest) {

    text(
      "roadblockPrice",
      `${nearest.timeframe} · ${num(nearest.price)}`
    );

    $("roadblockPrice")
      .className =
      "roadblock-price roadblock-warning";

    text(
      "roadblockBadge",
      `${nearest.type || "ROADBLOCK"} · ${num(nearest.distance)}`
    );

  } else {

    text(
      "roadblockPrice",
      "CLEAR"
    );

    $("roadblockPrice")
      .className =
      "roadblock-price roadblock-clear";

    text(
      "roadblockBadge",
      "NO ROADBLOCK"
    );
  }

  /* ========================================================
     SETUPS
     ======================================================== */

  const buy =
    setup.buy ||
    {};

  const sell =
    setup.sell ||
    {};

  text(
    "buySetupType",
    buy.type ||
    "NONE"
  );

  text(
    "buyAligned",
    yesNo(buy.aligned)
  );

  text(
    "buyContinuation",
    yesNo(buy.continuation)
  );

  text(
    "buyReversal",
    yesNo(buy.reversal)
  );

  text(
    "buyLocation",
    buy.location ||
    "--"
  );

  text(
    "buyH1Bias",
    buy.h1Bias ||
    "--"
  );

  text(
    "buyTarget",
    buy.targetSR?.price != null
      ? num(
          buy.targetSR.price
        )
      : "--"
  );

  text(
    "sellSetupType",
    sell.type ||
    "NONE"
  );

  text(
    "sellAligned",
    yesNo(sell.aligned)
  );

  text(
    "sellContinuation",
    yesNo(sell.continuation)
  );

  text(
    "sellReversal",
    yesNo(sell.reversal)
  );

  text(
    "sellLocation",
    sell.location ||
    "--"
  );

  text(
    "sellH1Bias",
    sell.h1Bias ||
    "--"
  );

  text(
    "sellTarget",
    sell.targetSR?.price != null
      ? num(
          sell.targetSR.price
        )
      : "--"
  );

  /* ========================================================
     REASONS
     ======================================================== */

  const reasons =
    Array.isArray(d.reasons)
      ? d.reasons
      : [];

  const reasonsEl =
    $("reasons");

  reasonsEl.innerHTML = "";

  if (!reasons.length) {

    const el =
      document.createElement(
        "div"
      );

    el.className =
      "reason";

    el.textContent =
      "No signal reasoning available.";

    reasonsEl.appendChild(el);

  } else {

    reasons.forEach(reason => {

      const el =
        document.createElement(
          "div"
        );

      el.className =
        "reason";

      el.textContent =
        reason;

      reasonsEl.appendChild(el);
    });
  }

  /* ========================================================
     CHART
     ======================================================== */

  drawChart(
    Array.isArray(d.candles)
      ? d.candles
      : [],
    price,
    signal
  );

  text(
    "chartSignal",
    signal
  );

  text(
    "chartInfo",
    `${Array.isArray(d.candles) ? d.candles.length : 0} M5 candles`
  );

  /* ========================================================
     DIAGNOSTICS
     ======================================================== */

  text(
    "diagM5",
    d.data?.m5Candles ??
    "--"
  );

  text(
    "diagM15",
    d.data?.m15Candles ??
    "--"
  );

  text(
    "diagH1",
    d.data?.h1Candles ??
    "--"
  );

  text(
    "diagSource",
    d.dataSource ||
    "--"
  );

  text(
    "diagCacheM5",
    ageText(
      d.cache?.ageSeconds?.m5
    )
  );

  text(
    "diagCacheM15",
    ageText(
      d.cache?.ageSeconds?.m15
    )
  );

  text(
    "diagCacheH1",
    ageText(
      d.cache?.ageSeconds?.h1
    )
  );

  text(
    "diagCandle",
    d.signalCandle ||
    "--"
  );
}

/* ============================================================
   INDICATOR DISPLAY HELPERS
   ============================================================ */

function boolSignal(obj) {

  if (!obj) {
    return "--";
  }

  if (obj.bullish) {
    return "BULLISH";
  }

  if (obj.bearish) {
    return "BEARISH";
  }

  return "NEUTRAL";
}

function momentumText(obj) {

  if (!obj) {
    return "--";
  }

  if (obj.bullish) {
    return `BULL ${obj.strength ?? 0}`;
  }

  if (obj.bearish) {
    return `BEAR ${obj.strength ?? 0}`;
  }

  return `${obj.strength ?? 0}`;
}

function ageText(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return "--";
  }

  const n =
    Number(value);

  if (!Number.isFinite(n)) {
    return "--";
  }

  if (n < 60) {
    return `${n}s`;
  }

  if (n < 3600) {
    return `${Math.floor(n / 60)}m`;
  }

  return `${Math.floor(n / 3600)}h`;
}

/* ============================================================
   CHART
   ============================================================ */

function drawChart(
  candles,
  currentPrice,
  signal
) {

  const canvas =
    $("chart");

  const rect =
    canvas.getBoundingClientRect();

  const dpr =
    window.devicePixelRatio ||
    1;

  const width =
    Math.max(
      1,
      Math.floor(
        rect.width * dpr
      )
    );

  const height =
    Math.max(
      1,
      Math.floor(
        rect.height * dpr
      )
    );

  canvas.width = width;
  canvas.height = height;

  const ctx =
    canvas.getContext("2d");

  ctx.clearRect(
    0,
    0,
    width,
    height
  );

  if (
    !candles ||
    candles.length < 2
  ) {
    return;
  }

  const data =
    candles.slice(-60);

  const highs =
    data.map(
      x => Number(x.high)
    );

  const lows =
    data.map(
      x => Number(x.low)
    );

  let max =
    Math.max(...highs);

  let min =
    Math.min(...lows);

  if (
    Number.isFinite(currentPrice)
  ) {
    max =
      Math.max(
        max,
        currentPrice
      );

    min =
      Math.min(
        min,
        currentPrice
      );
  }

  const range =
    Math.max(
      max - min,
      .01
    );

  const padX =
    15 * dpr;

  const padY =
    20 * dpr;

  const chartW =
    width -
    padX * 2;

  const chartH =
    height -
    padY * 2;

  function x(i) {
    return (
      padX +
      (
        i /
        Math.max(
          1,
          data.length - 1
        )
      ) *
      chartW
    );
  }

  function y(price) {
    return (
      padY +
      (
        1 -
        (
          price - min
        ) /
        range
      ) *
      chartH
    );
  }

  /* grid */

  ctx.lineWidth =
    1 * dpr;

  ctx.strokeStyle =
    "rgba(255,255,255,.045)";

  for (
    let i = 1;
    i < 5;
    i++
  ) {

    const yy =
      padY +
      (
        i / 5
      ) *
      chartH;

    ctx.beginPath();

    ctx.moveTo(
      padX,
      yy
    );

    ctx.lineTo(
      width - padX,
      yy
    );

    ctx.stroke();
  }

  /* area */

  const gradient =
    ctx.createLinearGradient(
      0,
      padY,
      0,
      height
    );

  gradient.addColorStop(
    0,
    "rgba(214,175,94,.16)"
  );

  gradient.addColorStop(
    1,
    "rgba(214,175,94,0)"
  );

  ctx.beginPath();

  data.forEach(
    (c, i) => {

      const xx =
        x(i);

      const yy =
        y(c.close);

      if (i === 0) {
        ctx.moveTo(
          xx,
          yy
        );
      } else {
        ctx.lineTo(
          xx,
          yy
        );
      }
    }
  );

  ctx.lineTo(
    x(data.length - 1),
    height - padY
  );

  ctx.lineTo(
    x(0),
    height - padY
  );

  ctx.closePath();

  ctx.fillStyle =
    gradient;

  ctx.fill();

  /* line */

  ctx.beginPath();

  data.forEach(
    (c, i) => {

      const xx =
        x(i);

      const yy =
        y(c.close);

      if (i === 0) {
        ctx.moveTo(
          xx,
          yy
        );
      } else {
        ctx.lineTo(
          xx,
          yy
        );
      }
    }
  );

  if (
    signal === "BUY"
  ) {
    ctx.strokeStyle =
      "#58e0a5";
  } else if (
    signal === "SELL"
  ) {
    ctx.strokeStyle =
      "#ff7b88";
  } else {
    ctx.strokeStyle =
      "#d6b15e";
  }

  ctx.lineWidth =
    2 * dpr;

  ctx.stroke();

  /* live price */

  if (
    Number.isFinite(currentPrice)
  ) {

    const yy =
      y(currentPrice);

    ctx.setLineDash([
      5 * dpr,
      5 * dpr
    ]);

    ctx.strokeStyle =
      "rgba(240,212,138,.55)";

    ctx.lineWidth =
      1 * dpr;

    ctx.beginPath();

    ctx.moveTo(
      padX,
      yy
    );

    ctx.lineTo(
      width - padX,
      yy
    );

    ctx.stroke();

    ctx.setLineDash([]);

    ctx.fillStyle =
      "#f0d48a";

    ctx.font =
      `${10 * dpr}px Arial`;

    ctx.textAlign =
      "right";

    ctx.fillText(
      Number(
        currentPrice
      ).toFixed(2),
      width - padX,
      yy - 5 * dpr
    );
  }
}

/* ============================================================
   PUSH
   ============================================================ */

function urlBase64ToUint8Array(
  base64String
) {

  const padding =
    "=".repeat(
      (
        4 -
        base64String.length % 4
      ) % 4
    );

  const base64 =
    (
      base64String +
      padding
    )
      .replace(
        /-/g,
        "+"
      )
      .replace(
        /_/g,
        "/"
      );

  const rawData =
    window.atob(
      base64
    );

  return Uint8Array.from(
    [...rawData].map(
      char => char.charCodeAt(0)
    )
  );
}

async function getPushConfig() {

  const response =
    await fetch(
      `/api/push-config?ts=${Date.now()}`,
      {
        cache: "no-store"
      }
    );

  const data =
    await response.json();

  if (
    !response.ok ||
    !data.publicKey
  ) {
    throw new Error(
      "VAPID public key unavailable"
    );
  }

  return data.publicKey;
}

async function saveSubscription(
  subscription
) {

  const response =
    await fetch(
      "/api/push-subscribe",
      {
        method: "POST",

        headers: {
          "content-type":
            "application/json"
        },

        body:
          JSON.stringify(
            subscription
          )
      }
    );

  const data =
    await response.json();

  if (
    !response.ok
  ) {
    throw new Error(
      data?.error ||
      "Push subscription failed"
    );
  }

  return data;
}

async function enablePush() {

  const btn =
    $("pushBtn");

  if (
    !("serviceWorker" in navigator)
  ) {
    toast(
      "Service Worker not supported."
    );

    return;
  }

  if (
    !("PushManager" in window)
  ) {
    toast(
      "Push notifications not supported."
    );

    return;
  }

  btn.disabled = true;
  btn.textContent = "CONNECTING...";

  try {

    pushRegistration =
      await navigator.serviceWorker.register(
        "/sw.js",
        {
          scope: "/"
        }
      );

    await navigator.serviceWorker.ready;

    const permission =
      await Notification.requestPermission();

    if (
      permission !== "granted"
    ) {
      throw new Error(
        "Notification permission not granted."
      );
    }

    const publicKey =
      await getPushConfig();

    const existing =
      await pushRegistration
        .pushManager
        .getSubscription();

    let subscription =
      existing;

    if (!subscription) {

      subscription =
        await pushRegistration
          .pushManager
          .subscribe({
            userVisibleOnly: true,
            applicationServerKey:
              urlBase64ToUint8Array(
                publicKey
              )
          });
    }

    await saveSubscription(
      subscription.toJSON()
    );

    localStorage.setItem(
      "xau_push_enabled",
      "1"
    );

    btn.textContent =
      "PUSH ENABLED";

    text(
      "pushStatus",
      "Push is active on this device."
    );

    toast(
      "XAU/USD push alerts enabled."
    );

  } catch (error) {

    console.error(
      "Push setup error:",
      error
    );

    btn.textContent =
      "ENABLE PUSH";

    text(
      "pushStatus",
      error?.message ||
      "Push setup failed."
    );

    toast(
      error?.message ||
      "Push setup failed."
    );

  } finally {

    btn.disabled = false;
  }
}

async function restorePushState() {

  try {

    if (
      !("serviceWorker" in navigator)
    ) {
      return;
    }

    pushRegistration =
      await navigator.serviceWorker.register(
        "/sw.js",
        {
          scope: "/"
        }
      );

    const subscription =
      await pushRegistration
        .pushManager
        .getSubscription();

    if (subscription) {

      text(
        "pushStatus",
        "Push subscription detected on this device."
      );

      $("pushBtn").textContent =
        "PUSH ENABLED";

      /*
       * Keep server synchronized.
       */

      await saveSubscription(
        subscription.toJSON()
      );
    }

  } catch (error) {

    console.warn(
      "Push restore:",
      error
    );
  }
}

$("pushBtn")
  .addEventListener(
    "click",
    enablePush
  );

/* ============================================================
   REFRESH BUTTON
   ============================================================ */

$("refreshBtn")
  .addEventListener(
    "click",
    async () => {

      $("refreshBtn")
        .style.transform =
        "rotate(180deg)";

      await loadData();

      setTimeout(
        () => {
          $("refreshBtn")
            .style.transform =
            "";
        },
        300
      );
    }
  );

/* ============================================================
   AUTO REFRESH
   ============================================================ */

function startRefresh() {

  clearInterval(
    refreshTimer
  );

  refreshTimer =
    setInterval(
      loadData,
      REFRESH_MS
    );
}

/* ============================================================
   RESIZE
   ============================================================ */

window.addEventListener(
  "resize",
  () => {

    if (
      lastData
    ) {

      drawChart(
        lastData.candles || [],
        Number(
          lastData.price
        ),
        lastData.signal
      );
    }
  }
);

/* ============================================================
   START
   ============================================================ */

(async function init() {

  text(
    "systemStatus",
    "Starting"
  );

  await restorePushState();

  await loadData();

  startRefresh();

})();
</script>

</body>
</html>
