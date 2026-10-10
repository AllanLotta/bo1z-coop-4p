# BO1 Zombies Co-op (vel.gg)

A Chrome extension that adds **2-player co-op** to the browser version of Black Ops 1 Zombies at
[vel.gg/bo1z](https://vel.gg/bo1z/). One player hosts, the other joins with an invite link, on the same Wi-Fi
or across the internet. It also adds **PS5 / PS4 / Xbox controller** support.

The game itself still runs from vel.gg; the extension only adds co-op on top of it, in your own browser.

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

## Controller

Plug in a controller and press any button on it. Click the game once with the mouse to start, then:
left stick move (L3 sprint), right stick aim, R2 fire, L2 aim down sights, R1 grenade, L1 special grenade,
Square reload / use / buy, Cross jump, Circle crouch (hold: prone), Triangle switch weapon, R3 knife,
D-pad equipment, Options menu. Aim speed: **Aim − / Aim +** on the card.

## How it works

The vel.gg game is the decompiled BO1 engine compiled to WebAssembly. Its multiplayer code is still inside, but
its network layer was cut. The extension makes a few small changes to the engine as the page loads it, and carries
the game's own packets between the two browsers through a small relay on Cloudflare. Source code and details:
[invictus841/bo1-zombies-decompiled, `browser-coop/`](https://github.com/invictus841/bo1-zombies-decompiled/tree/feature/browser-coop/browser-coop).
