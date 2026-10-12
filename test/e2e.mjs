// End-to-end: N real browsers (host + guests) with the extension on vel.gg through a relay.
//   node test/e2e.mjs [players=4] [map=nacht] [relay=http://127.0.0.1:8787]
import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs";

const PLAYERS = Number(process.argv[2] ?? 4);
const MAP = process.argv[3] ?? "nacht";
const RELAY = process.argv[4] ?? "http://127.0.0.1:8787";
const OUT = process.env.OUT ?? "/tmp/bo1e2e";
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const ext = path.resolve(".");
const room = "test-" + Math.random().toString(36).slice(2, 6) + "-" + Date.now().toString(36).slice(-4);
const ROOM = (Array.from({ length: 16 }, () => "0123456789abcdefghjkmnpqrstvwxyz"[Math.random() * 32 | 0]).join("")).match(/.{4}/g).join("-");
const relayParam = RELAY.includes("127.0.0.1") ? `&coopRelay=${encodeURIComponent(RELAY)}` : "";
const t0 = Date.now();
const log = (...a) => console.log(((Date.now() - t0) / 1000).toFixed(1).padStart(6), ...a);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(i) {
  // One profile per player, reused across runs: the game's cache is ~1 GB per profile.
  const dir = `/tmp/bo1e2e-profile-p${i}`;
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    viewport: { width: 800, height: 450 },
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessSendPreflights,PrivateNetworkAccessRespectPreflightResults", `--window-position=${(i % 2) * 820},${Math.floor(i / 2) * 540}`, "--window-size=800,520"],
  });
  // Test only: automated windows are refused pointer lock, which the game needs to leave its "click to start" screen.
  if (process.env.PAUSEMODE) await ctx.addInitScript((m) => localStorage.setItem("bo1z-coop-pause", m), process.env.PAUSEMODE);
  await ctx.addInitScript(() => {
    let locked = null;
    Object.defineProperty(Document.prototype, "pointerLockElement", { configurable: true, get: () => locked });
    Element.prototype.requestPointerLock = function () {
      locked = this;
      setTimeout(() => document.dispatchEvent(new Event("pointerlockchange")), 0);
      return Promise.resolve();
    };
    Document.prototype.exitPointerLock = function () {
      locked = null;
      setTimeout(() => document.dispatchEvent(new Event("pointerlockchange")), 0);
    };
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const file = `${OUT}/p${i + 1}.console.log`;
  page.on("console", (m) => fs.appendFileSync(file, m.text() + "\n"));
  page.on("pageerror", (e) => fs.appendFileSync(file, "PAGEERROR " + e.message + "\n"));
  return { i, ctx, page, name: i === 0 ? "host" : `p${i + 1}` };
}
const snap = (p) => p.page.evaluate(() => {
  const c = window.__bo1zCoop;
  if (!c) return null;
  return {
    screen: window.five?.screen, phase: c.phase, seat: c.seat, peer: c.peer, error: c.error,
    conn: c.mem?.connectionState?.() ?? null,
    guests: c.guests ? [...c.guests.values()].map((g) => `${g.seat}:${g.present ? "P" : "-"}:${g.state?.phase ?? "?"}:${g.slot?.state ?? 0}`).join(" ") : "",
    joinSeat: c.joinSeat, gate: c.gate,
    dbg: c.mem ? (() => { const m = c.mem; const clc = m.int(m.layout.client.clcPtr); return { sv: m.dvarInt("svPaused"), cl: m.dvarInt("clPaused"), lpt: clc ? m.int(clc + 12) : null, frz: m.int(m.layout.flags.freeze), intro: m.int(m.layout.browser.introState) }; })() : null, stats: c.stats && { in: c.stats.packetsIn, out: c.stats.packetsOut, fin: c.stats.framesIn, fout: c.stats.framesOut, rtt: c.stats.rtt && Math.round(c.stats.rtt), lost: c.stats.lost },
  };
}).catch((e) => ({ err: String(e.message).slice(0, 80) }));

const players = [];
for (let i = 0; i < PLAYERS; i += 1) players.push(await launch(i));
const [host, ...guests] = players;

await host.page.goto(`https://vel.gg/bo1z/${MAP}?coop=host&room=${ROOM}${relayParam}`);
await wait(1500);
// One guest loads at a time (four engines loading at once swamp a laptop); the next starts once the previous is in.
let nextGuest = 0;
const startGuest = async () => {
  const g = guests[nextGuest++];
  if (g) { log(`${g.name} opens the invite`); await g.page.goto(`https://vel.gg/bo1z/?coop=join&room=${ROOM}${relayParam}`); }
};
log("room", ROOM, "players", PLAYERS, "map", MAP);

let last = {};
let started = false;
const deadline = Date.now() + Number(process.env.DEADLINE_MIN ?? 8) * 60e3;
let allIn = false;
while (Date.now() < deadline) {
  for (const p of players) {
    const s = await snap(p);
    const key = JSON.stringify({ ...s, stats: undefined, dbg: undefined });
    if (s?.dbg && Date.now() - (p.dbgAt ?? 0) > 10e3) { p.dbgAt = Date.now(); log(p.name.padEnd(4), "dbg", JSON.stringify(s.dbg), s.stats ? `in=${s.stats.in} out=${s.stats.out}` : ""); }
    if (key !== last[p.name]) {
      log(p.name.padEnd(4), key);
      last[p.name] = key;
    }
    p.s = s;
    if (s?.screen === "landing") {
      await p.page.mouse.click(150, 300).catch(() => {});
      await p.page.keyboard.press("Space").catch(() => {});
    }
  }
  const hs = host.s;
  const prev = guests[nextGuest - 1];
  if (nextGuest < guests.length && hs?.screen === "ready" && (!prev || prev.s?.phase === "connected")) await startGuest();
  const guestsIn = guests.filter((g) => g.s?.phase === "connected" && g.s?.conn === 10).length;
  if (guestsIn === guests.length && !globalThis.allConnectedAt) globalThis.allConnectedAt = Date.now();
  // HOLD_S: the host waits this long in the lobby before starting (a guest waiting there must survive it).
  const holding = globalThis.allConnectedAt && Date.now() - globalThis.allConnectedAt < Number(process.env.HOLD_S ?? 0) * 1e3;
  if (!started && !holding && hs?.screen === "ready" && !hs.gate && guestsIn === guests.length) {
    log("all guests connected; host clicks to start");
    await host.page.mouse.click(150, 300);
    started = true;
  }
  if (started && guestsIn === guests.length && hs?.screen === "playing") {
    for (const g of guests) if (g.s?.screen === "ready") await g.page.mouse.click(150, 300);
    if (guests.every((g) => g.s?.screen === "playing")) { allIn = true; break; }
  }
  if (players.some((p) => p.s?.error)) { log("ERROR", players.map((p) => p.s?.error)); break; }
  await wait(1000);
}
log(allIn ? "ALL PLAYERS IN THE GAME" : "NOT ALL IN");

if (allIn) {
  await wait(4000);
  // Every guest walks forward for a moment; the host checks the server sees everyone.
  for (const g of guests) { await g.page.keyboard.down("w"); }
  await wait(1500);
  for (const g of guests) { await g.page.keyboard.up("w"); }
  await host.page.evaluate(() => window.__bo1zCoop.mem.command("status"));
  await wait(1500);
  for (const p of players) await p.page.screenshot({ path: `${OUT}/${p.name}.png` }).catch(() => {});
  if (process.env.PAUSETEST) {
    // The reported bug: one player pressing Escape (menu) or T (chat) crashed the others.
    const check = async (what) => {
      await wait(4000);
      const bad = [];
      for (const p of players) { const s = await snap(p); if (s?.screen === "error" || (p !== host && s?.phase !== "connected")) bad.push(`${p.name}:${s?.screen}/${s?.phase}`); }
      log(bad.length ? `FAIL after ${what}: ${bad.join(" ")}` : `ok  after ${what}`);
      return bad.length === 0;
    };
    const actors = [guests[0], host, guests.at(-1)];
    for (let round = 0; round < Number(process.env.PAUSETEST); round += 1) {
      for (const who of actors) {
        await who.page.keyboard.press("Escape"); await wait(3000);
        log(`${who.name} Escape -> host paused=${await host.page.evaluate(() => window.__bo1zCoop.pausedApplied)}`);
        await who.page.keyboard.press("Escape"); await wait(500); await who.page.mouse.click(150, 300);
        if (!(await check(`${who.name} Esc x2 (round ${round + 1})`))) break;
        await who.page.keyboard.press("t"); await wait(1000); await who.page.keyboard.type("oi"); await wait(500); await who.page.keyboard.press("Enter"); await wait(500); await who.page.mouse.click(150, 300);
        if (!(await check(`${who.name} chat T (round ${round + 1})`))) break;
      }
    }
    for (const p of players) await p.page.screenshot({ path: `${OUT}/${p.name}-after.png` }).catch(() => {});
  }
  // run a while to watch stability
  for (let k = 0; k < Number(process.env.SOAK ?? 30); k += 1) {
    await wait(1000);
    if (k % 10 === 9) for (const p of players) { const s = await snap(p); log(p.name.padEnd(4), JSON.stringify(s)); }
  }
}
for (const p of players) {
  const l = await p.page.evaluate(() => window.__bo1zCoop?.log ?? []).catch(() => []);
  fs.writeFileSync(`${OUT}/${p.name}.coop.log`, l.join("\n"));
}
if (!process.env.KEEP) for (const p of players) await p.ctx.close().catch(() => {});
log("done; logs in", OUT);
process.exit(allIn ? 0 : 1);
