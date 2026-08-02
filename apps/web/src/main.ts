import "@fontsource-variable/instrument-sans";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "./styles.css";
import { initFilm } from "./film";
import { type StageApi, initStage } from "./fx/scene";
import { Spring1 } from "./fx/springs";
import { initTheme } from "./theme";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* nav */
const nav = document.getElementById("nav")!;
const onScroll = (): void => {
  nav.classList.toggle("scrolled", window.scrollY > 10);
};
window.addEventListener("scroll", onScroll, { passive: true });
onScroll();

/* reveals */
if (!reducedMotion) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("in");
          io.unobserve(e.target);
        }
      }
    },
    { threshold: 0.14, rootMargin: "0px 0px -6% 0px" },
  );
  for (const el of document.querySelectorAll(".reveal")) io.observe(el);
} else {
  for (const el of document.querySelectorAll(".reveal")) el.classList.add("in");
}

/* hero tabs — the two ways in */
const ASK_TABS: Record<string, { prefix: string; text: string }> = {
  you: { prefix: "$", text: "npm create open-take@latest" },
  agent: { prefix: "›", text: "Make a demo of localhost:3000 for Twitter." },
};
const heroCmd = document.getElementById("hero-cmd") as HTMLButtonElement | null;
const cmdPrefix = document.getElementById("cmd-prefix");
const cmdText = document.getElementById("cmd-text");
const askTabs = [...document.querySelectorAll<HTMLButtonElement>(".ask-tab")];
for (const tab of askTabs) {
  tab.addEventListener("click", () => {
    const def = ASK_TABS[tab.dataset.tab ?? "you"]!;
    for (const t of askTabs) {
      t.classList.toggle("on", t === tab);
      t.setAttribute("aria-selected", String(t === tab));
    }
    if (cmdPrefix) cmdPrefix.textContent = def.prefix;
    if (cmdText) cmdText.textContent = def.text;
    if (heroCmd) heroCmd.dataset.copy = def.text;
  });
}

/* the composition ↔ render toggle */
const jsonZoom = document.getElementById("json-zoom") as HTMLButtonElement | null;
const rframe = document.getElementById("rframe");
const rcState = document.getElementById("rc-state");
if (jsonZoom && rframe) {
  jsonZoom.addEventListener("click", () => {
    const on = jsonZoom.getAttribute("aria-pressed") !== "true";
    jsonZoom.setAttribute("aria-pressed", String(on));
    jsonZoom.textContent = String(on);
    rframe.classList.toggle("punched", on);
    if (rcState) rcState.textContent = on ? "zoom 1.8× on “Deploy”" : "zoom off — full view";
  });
}

/* star count — social proof only once it exists */
const ghStars = document.getElementById("gh-stars");
if (ghStars) {
  const show = (n: number): void => {
    if (n < 20) return;
    ghStars.textContent = `★ ${n >= 1000 ? `${(n / 1000).toFixed(1)}k` : n}`;
    ghStars.hidden = false;
  };
  try {
    const cached = JSON.parse(localStorage.getItem("ot-stars") ?? "null") as {
      n: number;
      t: number;
    } | null;
    if (cached && Date.now() - cached.t < 6 * 3600_000) {
      show(cached.n);
    } else {
      fetch("https://api.github.com/repos/pascal910107/open-take")
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { stargazers_count?: number } | null) => {
          const n = data?.stargazers_count;
          if (typeof n === "number") {
            localStorage.setItem("ot-stars", JSON.stringify({ n, t: Date.now() }));
            show(n);
          }
        })
        .catch(() => {});
    }
  } catch {
    /* stars are decoration — never let them break the page */
  }
}

/* copy chips — icon flips to a check; the sr span announces it */
for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-copy]")) {
  const sr = btn.querySelector("[data-copy-sr]");
  let undo = 0;
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy ?? "");
      btn.classList.add("did");
      if (sr) sr.textContent = "Copied";
      window.clearTimeout(undo);
      undo = window.setTimeout(() => {
        btn.classList.remove("did");
        if (sr) sr.textContent = "Copy to clipboard";
      }, 1600);
    } catch {
      /* clipboard unavailable — the command is right there to select */
    }
  });
}

/* terminal */
interface TermLine {
  text: string;
  cls: string;
  cps?: number;
}
const TERM_LINES: TermLine[] = [
  { text: "$ npm create open-take@latest", cls: "t-cmd" },
  { text: "✓ open-take installed — skill added for your agent", cls: "t-ok" },
  { text: "", cls: "t-dim" },
  { text: "you › make a demo of localhost:3000 for Twitter", cls: "t-you", cps: 34 },
  { text: "", cls: "t-dim" },
  { text: "● exploring — inspect: 23 interactive elements, real bboxes", cls: "t-agent" },
  { text: "● thesis — the file-drop is the hero · 5 beats · 24 s", cls: "t-agent" },
  { text: "● shooting — capture landed (Retina, 60 fps)", cls: "t-agent" },
  { text: "● rendering — demo.mp4 + demo.take/ ready", cls: "t-agent" },
  { text: "", cls: "t-dim" },
  { text: "$ open demos/demo.mp4", cls: "t-cmd" },
];

function typeTerminal(pre: HTMLElement): void {
  if (reducedMotion) {
    pre.innerHTML = TERM_LINES.map(
      (l) => `<span class="${l.cls}">${l.text.replace(/</g, "&lt;")}</span>`,
    ).join("\n");
    return;
  }
  const caret = document.createElement("span");
  caret.className = "t-caret";
  let li = 0;
  const nextLine = (): void => {
    if (li >= TERM_LINES.length) {
      caret.remove();
      return;
    }
    const line = TERM_LINES[li]!;
    li++;
    const span = document.createElement("span");
    span.className = line.cls;
    pre.append(span, caret);
    let ci = 0;
    const cps = line.cps ?? 78;
    const tick = (): void => {
      if (ci < line.text.length) {
        ci++;
        span.textContent = line.text.slice(0, ci);
        setTimeout(tick, 1000 / cps + Math.random() * 22);
      } else {
        pre.append(document.createTextNode("\n"));
        setTimeout(nextLine, line.text ? 210 : 60);
      }
    };
    tick();
  };
  nextLine();
}

const termBody = document.getElementById("term-body");
if (termBody) {
  const io = new IntersectionObserver(
    (entries) => {
      if (entries[0]?.isIntersecting) {
        io.disconnect();
        typeTerminal(termBody);
      }
    },
    { threshold: 0.4 },
  );
  io.observe(termBody);
}

/* the camera's curve — plotted from the real spring, not drawn by hand */
function buildScope(): void {
  const svg = document.getElementById("scope-svg");
  if (!svg) return;
  const NS = "http://www.w3.org/2000/svg";
  const el = (name: string, attrs: Record<string, string>): SVGElement => {
    const node = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    return node;
  };

  const TOTAL = 3.4;
  const PUNCH_AT = 0.12;
  const RELEASE_AT = 1.55;
  const spring = new Spring1(1, 8.2);
  const pts: Array<[number, number]> = [];
  const X = (t: number): number => 20 + (t / TOTAL) * 520;
  const Y = (m: number): number => 262 - ((m - 1) / 1.3) * 220;
  for (let t = 0; t <= TOTAL; t += 1 / 120) {
    if (t >= PUNCH_AT) spring.target = 2.3;
    if (t >= RELEASE_AT) {
      spring.target = 1;
      spring.w = 4.6;
    }
    spring.step(1 / 120);
    pts.push([X(t), Y(spring.x)]);
  }
  const d = pts
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");

  const defs = el("defs", {});
  const grad = el("linearGradient", { id: "scope-fill", x1: "0", y1: "0", x2: "0", y2: "1" });
  grad.append(
    el("stop", { offset: "0", style: "stop-color: var(--acc); stop-opacity: 0.28" }),
    el("stop", { offset: "1", style: "stop-color: var(--acc); stop-opacity: 0" }),
  );
  defs.append(grad);
  svg.append(defs);

  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  svg.append(
    el("path", {
      d: `${d} L${last[0].toFixed(1)} 262 L${first[0].toFixed(1)} 262 Z`,
      fill: "url(#scope-fill)",
    }),
  );
  for (const t of [PUNCH_AT, 0.95, RELEASE_AT]) {
    svg.append(
      el("line", {
        x1: X(t).toFixed(1),
        y1: "24",
        x2: X(t).toFixed(1),
        y2: "276",
        stroke: "rgba(255,255,255,0.09)",
        "stroke-dasharray": "3 5",
      }),
    );
  }
  svg.append(
    el("path", {
      d,
      fill: "none",
      style: "stroke: rgb(var(--acc-hi-rgb) / 0.28)",
      "stroke-width": "6",
    }),
    el("path", {
      d,
      fill: "none",
      style: "stroke: var(--acc-hi)",
      "stroke-width": "2.2",
      "stroke-linecap": "round",
    }),
  );
  const label = el("text", {
    x: "532",
    y: "42",
    "text-anchor": "end",
    fill: "rgba(165,165,177,0.8)",
    "font-size": "11",
    "font-family": "Geist Mono, monospace",
    "letter-spacing": "1",
  });
  label.textContent = "ζ = 1 · critically damped";
  svg.append(label);

  if (!reducedMotion) {
    const dot = el("circle", { r: "4.5", style: "fill: var(--acc-light)" });
    const halo = el("circle", { r: "10", style: "fill: rgb(var(--acc-hi-rgb) / 0.25)" });
    for (const c of [halo, dot]) {
      const motion = el("animateMotion", { dur: "5.6s", repeatCount: "indefinite", path: d });
      c.append(motion);
      svg.append(c);
    }
  }
}
buildScope();

/* the take */
const film = document.getElementById("film") as HTMLVideoElement | null;
const filmPlay = document.getElementById("film-play");
if (film && filmPlay) initFilm(film, filmPlay);

/* the stage */
const canvas = document.getElementById("stage") as HTMLCanvasElement | null;
const hudTc = document.getElementById("hud-tc");
const hudShot = document.getElementById("hud-shot");
let stage: StageApi | null = null;
if (canvas) {
  stage = initStage(canvas, {
    shot(label) {
      if (hudShot) hudShot.textContent = label;
    },
    timecode(tc) {
      if (hudTc) hudTc.textContent = tc;
    },
  });
  if (!stage) {
    canvas.style.display = "none";
    document.querySelector(".hud")?.remove();
  }
}

/* dark / light — the head script applied the stored theme before paint;
   the stage renders its own colours, so it is what needs keeping in step */
initTheme((light) => stage?.setTheme(light ? "light" : "dark"));
