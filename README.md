# BO1 Zombies Co-op 4P (fork of invictus841's co-op extension)

A fork of [invictus841/bo1z-coop-extension](https://github.com/invictus841/bo1z-coop-extension) for
[vel.gg/bo1z](https://vel.gg/bo1z/) that supports **up to 4 players** (a host and three friends), on its own relay.

What changed from upstream:

- **Up to 4 players.** The relay holds one host and up to three guests per room (protocol v3). The host gives each
  guest its own engine loopback ring and port; every guest's packets enter the server through one shared ring, each
  stamped with its guest's port. Guests connect one at a time (a join turn), each with its own qport, because the server
  tells loopback clients apart only by qport and port.
- **Fixed: pressing Escape or T crashed the other players** (upstream had it too). With a menu or the chat open, a
  client marks its usercmds; the other clients then draw a "player in a menu" effect whose material zombies never
  loads (`Material_GetTechnique` ← `fx_drawCallback`, *unreachable*). The patched engine never sets that bit.
- **Fixed: a guest waiting in the lobby got dropped (`EXE_ERR_CLIENT_CMD_OVERFLOW`).** Guests sent the host a
  reliable `sl` command for every script sound, which only the host's own client should send.
- A guest reload keeps its seat, and the host's player list shows players 2-4.

Everyone in a game needs this fork (it does not talk to the 2-player version), and everyone must use the same relay.

Tests: `node test/relay.test.mjs` (relay routing, against `npx wrangler dev --config relay/wrangler.jsonc`) and
`node test/e2e.mjs <players> <map>` (real browsers on vel.gg with the extension; `PAUSETEST=1` presses Escape and T).

---

# BO1 Zombies 2-Player Co-op, by invictus841 (for vel.gg by MisaDev4)

A Chrome extension by **invictus841** that adds **2-player co-op** to [vel.gg/bo1z](https://vel.gg/bo1z/), the
browser version of Black Ops 1 Zombies made by **MisaDev4**. One player hosts, the other joins with an invite
link, from anywhere: online, over the internet (you don't need to be on the same Wi-Fi). It also adds **PS5 / PS4 / Xbox controller** support.


The game itself still runs from vel.gg; the extension only adds co-op on top of it, in your own browser.

Thanks to **MisaDev4** for vel.gg and the decompiled engine
([MisaDev4/bo1-zombies-decompiled](https://github.com/MisaDev4/bo1-zombies-decompiled)).
Co-op extension by **invictus841**.

## Install (both players)

1. Click the green **Code** button above → **Download ZIP**, and unzip it.
2. In Chrome, open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and select the unzipped folder (the one containing `manifest.json`).

## Play

- **Host:** go to [vel.gg/bo1z](https://vel.gg/bo1z/). In the **Co-op** card (top right), click **Host a game**,
  then **Copy invite link**, send it to your friend, and pick a map. Your start waits until they are in.
- **Player 2:** open the invite link, press a key when the page asks, wait for **"In the host's game"**, then
  click the game.

Good to know:
- Pausing (Escape, or Options on a controller) pauses the game for both players.
- If player 2 gets disconnected, they click **Rejoin** on the card. Joining mid-round means watching until the
  next round, as in the original game.
- If player 2 spawns far away, their card has **Go to player 1** (press Escape to see it).

## Known issues

- **Spawns on some maps are buggy.** On **Five** for example, at the very first spawn both players can die right
  away and the game ends. Don't worry: a few seconds later a new game starts on its own, and both players spawn
  correctly.
- If player 2 still lands somewhere odd, press Escape and use **Go to player 1** on their card.

## Controller

Plug in a controller and press any button on it. Click the game once with the mouse to start, then:
left stick move (L3 sprint), right stick aim, R2 fire, L2 aim down sights, R1 grenade, L1 special grenade,
Square reload / use / buy, Cross jump, Circle crouch (hold: prone), Triangle switch weapon, R3 knife,
D-pad equipment, Options menu. Aim speed: **Aim − / Aim +** on the card.

## The relay: shared by default, or your own

The two browsers are connected through a small relay on Cloudflare. **By default everyone uses the shared relay,
which runs on invictus841's free Cloudflare plan.** It allows roughly **6 hours of play per day in total, for
everyone together**. When that is used up, co-op stops working for the rest of the day (it resets at midnight
UTC). Nobody is charged anything. The Co-op card shows a bar with how much of today's shared allowance is
used (an estimate).

To get your own allowance instead of sharing it with everyone, run your own relay, free, in about five minutes.
Your relay has the same free allowance (about 6 hours of play a day), but it is only used by the people you
play with.

1. Make a free account at [cloudflare.com](https://dash.cloudflare.com/sign-up) and **confirm your email address**
   (Cloudflare does not deploy anything before that).
2. Install [Node.js](https://nodejs.org), version 22 or newer.
3. Open a terminal **in the unzipped folder of this extension** (the one containing `package.json`) and run:
   ```sh
   npm install
   npx wrangler login
   npm run deploy
   ```
   `npx wrangler login` opens your browser: click **Allow**. The first time you deploy, Cloudflare may ask you to
   choose a `workers.dev` name: pick any. At the end it prints your relay's address, like
   `https://bo1-zombies-coop-relay.<your-name>.workers.dev`.
4. On vel.gg, in the Co-op card: **Change relay** → paste that address → **Save**.

Both players must use the same relay. The host's invite links carry it, so player 2 just clicks
**Use this relay** on their card.

## How it works

The vel.gg game is the decompiled BO1 engine compiled to WebAssembly. Its multiplayer code is still inside, but
its network layer was cut. The extension makes a few small changes to the engine as the page loads it, and carries
the game's own packets between the two browsers through the relay (`relay/`), which forwards them without looking
inside.

## Make it your own

This is a starting base, shared as is. It isn't maintained, and changes aren't reviewed or merged here.

Want to fix a bug or add something? **Fork** this repo (button at the top right) and work on your own copy: fix
it yourself, with AI tools if you like, and share your version with whoever you want.

All of the extension's code is in `dist/coop-main.js`, one readable JavaScript file you can edit directly. The relay's
code is in `relay/`.
