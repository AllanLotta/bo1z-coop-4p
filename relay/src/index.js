import { DurableObject } from "cloudflare:workers";
import {
  MAX_BINARY_BYTES,
  MAX_TEXT_BYTES,
  PROTOCOL_VERSION,
  ROLES,
  ROOM_ID_PATTERN,
  isPeerMessage,
  parseControl,
} from "../../shared/protocol.js";

const REPLACED_CLOSE_CODE = 4001;

// Daily usage estimate (GET /usage): Cloudflare's free plan allows 100,000 Durable Object requests a day, and bills
// incoming WebSocket messages at 20 per request. Each room reports what it carried to one shared counter.
const FREE_DAILY_REQUESTS = 100000;
const MESSAGES_PER_REQUEST = 20;
const USAGE_FLUSH_MS = 60000;
const utcDay = (time = Date.now()) => new Date(time).toISOString().slice(0, 10);
const PROTOCOL_CLOSE_CODE = 4003;
const TOO_BIG_CLOSE_CODE = 1009;

// Token buckets per socket. Excess binary frames are dropped silently, like UDP
// packets; the engine's netchan already copes with loss.
const BINARY_RATE = 400;
const BINARY_BURST = 800;
const TEXT_RATE = 20;
const TEXT_BURST = 40;

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isOriginAllowed(request, env) {
  // Browsers always send Origin on a WebSocket upgrade; tools and tests do not.
  const origin = request.headers.get("Origin");
  return !origin || allowedOrigins(env).includes(origin);
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  if (!origin || !isOriginAllowed(request, env)) return {};
  return { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-methods": "GET, OPTIONS" };
}

function isWebSocketUpgrade(request) {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function roomIdFromPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "v1" || parts[1] !== "rooms") return null;
  try {
    const roomId = decodeURIComponent(parts[2]);
    return ROOM_ID_PATTERN.test(roomId) ? roomId : null;
  } catch {
    return null;
  }
}

/** Public Worker: validates the upgrade and routes each room to one Durable Object. */
export default {
  async fetch(request, env) {
    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, protocol: PROTOCOL_VERSION }, 200, headers);
    }
    if (request.method === "GET" && url.pathname === "/usage") {
      const counter = env.USAGE.get(env.USAGE.idFromName("global"));
      const usage = await (await counter.fetch("https://usage/read")).json();
      return json(usage, 200, { ...headers, "cache-control": "public, max-age=60" });
    }

    const roomId = roomIdFromPath(url.pathname);
    if (!roomId) return json({ error: "not_found" }, 404, headers);
    if (!isOriginAllowed(request, env)) return json({ error: "origin_not_allowed" }, 403, headers);
    if (!isWebSocketUpgrade(request)) return json({ error: "websocket_upgrade_required" }, 426, headers);

    const role = url.searchParams.get("role");
    if (!ROLES.includes(role)) return json({ error: "invalid_role" }, 400, headers);
    const version = Number(url.searchParams.get("v") ?? PROTOCOL_VERSION);
    if (version !== PROTOCOL_VERSION) return json({ error: "protocol_mismatch", protocol: PROTOCOL_VERSION }, 400, headers);

    const forwardedHeaders = new Headers(request.headers);
    // Set by this Worker only; never trusted from the client.
    forwardedHeaders.set("x-bo1-room-id", roomId);
    forwardedHeaders.set("x-bo1-role", role);
    const id = env.ROOM_RELAY.idFromName(`bo1-coop:${roomId}`);
    return env.ROOM_RELAY.get(id).fetch(new Request(request, { headers: forwardedHeaders }));
  },
};

/**
 * A room of two: one host, one guest. The relay forwards binary packet batches
 * and peer control messages between them and never inspects game data. A new
 * connection for a role replaces the old one (a page reload or navigation).
 * Uses the hibernation API; roles live in socket tags and attachments.
 */
export class RoomRelay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Rate-limit state is per instance; it simply resets after hibernation.
    this.buckets = new Map();
    this.usage = { messages: 0, connections: 0, flushedAt: Date.now() };
  }

  async fetch(request) {
    const roomId = request.headers.get("x-bo1-room-id");
    const role = request.headers.get("x-bo1-role");
    if (!roomId || !ROOM_ID_PATTERN.test(roomId) || !ROLES.includes(role) || !isWebSocketUpgrade(request)) {
      return json({ error: "invalid_room_request" }, 400);
    }

    for (const old of this.socketsFor(role)) {
      this.send(old, { t: "error", code: "replaced" });
      this.safeClose(old, REPLACED_CLOSE_CODE, "Replaced by a new connection");
    }

    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [role]);
    this.count(0, 1);
    server.serializeAttachment({ roomId, role, joinedAt: Date.now() });

    const peer = this.peerOf(role);
    this.send(server, { t: "welcome", v: PROTOCOL_VERSION, role, peer: peer !== null });
    if (peer) this.send(peer, { t: "peer", present: true });

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, payload) {
    this.count(1, 0);
    const role = this.roleOf(socket);
    if (!role) {
      this.safeClose(socket, PROTOCOL_CLOSE_CODE, "Unknown connection");
      return;
    }

    if (typeof payload === "string") {
      if (payload.length > MAX_TEXT_BYTES) {
        this.safeClose(socket, TOO_BIG_CLOSE_CODE, "Text frame too large");
        return;
      }
      if (!this.take(socket, "text", TEXT_RATE, TEXT_BURST)) {
        this.send(socket, { t: "error", code: "rate_limited" });
        return;
      }
      const message = parseControl(payload);
      if (!isPeerMessage(message)) {
        this.send(socket, { t: "error", code: "bad_message" });
        return;
      }
      const peer = this.peerOf(role);
      if (peer) this.sendRaw(peer, payload);
      return;
    }

    if (payload.byteLength > MAX_BINARY_BYTES) {
      this.safeClose(socket, TOO_BIG_CLOSE_CODE, "Binary frame too large");
      return;
    }
    if (!this.take(socket, "binary", BINARY_RATE, BINARY_BURST)) return;
    const peer = this.peerOf(role);
    if (peer) this.sendRaw(peer, payload);
  }

  webSocketClose(socket, code, reason) {
    this.leave(socket);
    // Complete the close handshake; the runtime does not do it for us.
    this.safeClose(socket, code === 1005 || code === 1006 ? 1000 : code, reason);
  }

  webSocketError(socket) {
    this.leave(socket);
    this.safeClose(socket, PROTOCOL_CLOSE_CODE, "WebSocket error");
  }

  leave(socket) {
    this.buckets.delete(socket);
    this.flushUsage();
    const role = this.roleOf(socket);
    if (!role) return;
    // A replaced socket leaves while its successor is already open: the peer
    // never noticed a gap, so do not tell it the other player left.
    if (this.socketsFor(role, socket).length > 0) return;
    const peer = this.peerOf(role);
    if (peer) this.send(peer, { t: "peer", present: false });
  }

  count(messages, connections) {
    this.usage.messages += messages;
    this.usage.connections += connections;
    if (Date.now() - this.usage.flushedAt >= USAGE_FLUSH_MS) this.flushUsage();
  }

  /** Adds what this room carried since the last report to the shared counter (a request itself, once a minute). */
  flushUsage() {
    const { messages, connections } = this.usage;
    this.usage = { messages: 0, connections: 0, flushedAt: Date.now() };
    if (!messages && !connections) return;
    const counter = this.env.USAGE.get(this.env.USAGE.idFromName("global"));
    const report = counter.fetch("https://usage/add", { method: "POST", body: JSON.stringify({ messages, connections }) })
      .catch(() => {});
    this.ctx.waitUntil(report);
  }

  roleOf(socket) {
    const attachment = socket.deserializeAttachment();
    return attachment && ROLES.includes(attachment.role) ? attachment.role : null;
  }

  /** Open sockets holding `role`, excluding `except` (getWebSockets() still lists a closing socket). */
  socketsFor(role, except) {
    return this.ctx
      .getWebSockets(role)
      .filter((socket) => socket !== except && socket.readyState === 1 /* OPEN */);
  }

  peerOf(role) {
    const [peer] = this.socketsFor(role === "host" ? "guest" : "host");
    return peer ?? null;
  }

  take(socket, kind, rate, burst) {
    const now = Date.now();
    let bucket = this.buckets.get(socket);
    if (!bucket) {
      bucket = { binary: { tokens: BINARY_BURST, at: now }, text: { tokens: TEXT_BURST, at: now } };
      this.buckets.set(socket, bucket);
    }
    const state = bucket[kind];
    state.tokens = Math.min(burst, state.tokens + ((now - state.at) / 1000) * rate);
    state.at = now;
    if (state.tokens < 1) return false;
    state.tokens -= 1;
    return true;
  }

  send(socket, message) {
    this.sendRaw(socket, JSON.stringify(message));
  }

  sendRaw(socket, payload) {
    try {
      socket.send(payload);
    } catch {
      // The peer closed between lookup and send; its close handler cleans up.
    }
  }

  safeClose(socket, code, reason) {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}

/** One instance ("global"): today's totals, keyed by UTC day so the count restarts when Cloudflare's does. */
export class UsageCounter extends DurableObject {
  async fetch(request) {
    const day = utcDay();
    const stored = (await this.ctx.storage.get("usage")) ?? {};
    const usage = stored.day === day ? stored : { day, messages: 0, connections: 0, reports: 0 };
    if (request.method === "POST") {
      let body = {};
      try { body = await request.json(); } catch { /* empty */ }
      usage.messages += Math.max(0, Math.min(1e7, Number(body.messages) || 0));
      usage.connections += Math.max(0, Math.min(1e5, Number(body.connections) || 0));
      usage.reports += 1;
      await this.ctx.storage.put("usage", usage);
      return new Response(null, { status: 204 });
    }
    // Estimated requests: messages at 20 per request, one per connection, one per report to this counter.
    const requests = Math.ceil(usage.messages / MESSAGES_PER_REQUEST) + usage.connections + usage.reports;
    const tomorrow = new Date(`${day}T00:00:00Z`).getTime() + 86400000;
    return Response.json({
      day,
      requests,
      limit: FREE_DAILY_REQUESTS,
      fraction: Math.min(1, requests / FREE_DAILY_REQUESTS),
      resetsAt: new Date(tomorrow).toISOString(),
      estimate: true,
    });
  }
}
