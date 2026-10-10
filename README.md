# BO1 Zombies 2-Player Co-op, by invictus841 (for vel.gg by MisaDev4)

A Chrome extension by **invictus841** that adds **2-player co-op** to [vel.gg/bo1z](https://vel.gg/bo1z/), the
browser version of Black Ops 1 Zombies made by **MisaDev4**. One player hosts, the other joins with an invite
link, from anywhere: online, over the internet (you don't need to be on the same Wi-Fi). It also adds **PS5 / PS4 / Xbox controller** support.

Co-op is for **2 players only** (a host and one friend), not 3 or 4.

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
UTC). Nobody is charged anything.

To play without that limit, run your own relay, free, in about five minutes:

1. Make a free account at [cloudflare.com](https://dash.cloudflare.com/sign-up) and install [Node.js](https://nodejs.org).
2. In this folder, in a terminal:
   ```sh
   npm install
   npx wrangler login
   npm run deploy
   ```
   It prints your relay's address, like `https://bo1-zombies-coop-relay.<your-name>.workers.dev`.
3. On vel.gg, in the Co-op card: **Change relay** → paste that address → **Save**.

Both players must use the same relay. The host's invite links carry it, so player 2 just clicks
**Use this relay** on their card. Your relay has its own free allowance (about 6 hours of play a day).

## How it works

The vel.gg game is the decompiled BO1 engine compiled to WebAssembly. Its multiplayer code is still inside, but
its network layer was cut. The extension makes a few small changes to the engine as the page loads it, and carries
the game's own packets between the two browsers through the relay (`relay/`), which forwards them without looking
inside.

## Make it your own

This is a starting base, shared as is. It isn't maintained, and changes aren't reviewed or merged here.

Want to fix a bug or add something? **Fork** this repo (button at the top right) and work on your own copy: fix
it yourself, with AI tools if you like, and share your version with whoever you want.

The extension's source code (plain JavaScript, built into `dist/coop-main.js`) and its tests are in
[invictus841/bo1-zombies-decompiled, `browser-coop/`](https://github.com/invictus841/bo1-zombies-decompiled/tree/feature/browser-coop/browser-coop).
