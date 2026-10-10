/**
 * Wire protocol shared by the relay (relay/src/index.js) and the browser
 * extension (extension/src). Version 2 tunnels the engine's own loopback
 * packets; the relay never looks inside them.
 *
 * A room holds one host and one guest. Each opens
 *   wss://<relay>/v1/rooms/<room>?role=host|guest
 *
 * Text frames are small JSON objects with a string `t`:
 *   relay -> client: welcome { role, peer }, peer { present }, error { code }
 *   client -> peer:  any other `t` (info, state, ping, pong, bye), forwarded verbatim
 * Binary frames are packet batches (encodePackets) and are forwarded verbatim.
 */

export const PROTOCOL_VERSION = 2;
export const ROLES = Object.freeze(["host", "guest"]);
export const RELAY_MESSAGE_TYPES = Object.freeze(["welcome", "peer", "error"]);

export const MAX_TEXT_BYTES = 4096;
export const MAX_BINARY_BYTES = 65536;
// One engine loopback slot carries at most 1264 bytes (loopmsg_t data).
export const MAX_PACKET_BYTES = 1264;

export const ROOM_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
// Crockford base32 without i, l, o, u: no look-alike characters when read aloud.
const ROOM_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
export const ROOM_CODE_LENGTH = 16; // 80 bits

export function createRoomCode(random = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = random(new Uint8Array(ROOM_CODE_LENGTH));
  let code = "";
  for (const byte of bytes) code += ROOM_ALPHABET[byte & 31];
  return code.match(/.{4}/g).join("-");
}

/** Accepts what people paste: any case, spaces, a full invite link. */
export function normalizeRoomCode(input) {
  if (typeof input !== "string") return null;
  let text = input.trim();
  try {
    const url = new URL(text);
    text = url.searchParams.get("room") ?? "";
  } catch {
    // Not a URL: a bare code.
  }
  const compact = text.toLowerCase().replace(/[^0-9a-z]/g, "");
  if (compact.length !== ROOM_CODE_LENGTH || [...compact].some((c) => !ROOM_ALPHABET.includes(c))) return null;
  return compact.match(/.{4}/g).join("-");
}

export function relaySocketUrl(relayBase, room, role) {
  const url = new URL(relayBase);
  url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:";
  url.pathname = `/v1/rooms/${encodeURIComponent(room)}`;
  url.search = `?role=${role}&v=${PROTOCOL_VERSION}`;
  return url.toString();
}

/**
 * Binary packet batch:
 *   u8 version (1) | u8 kind (1 = packets) | u16 LE count | count x (u16 LE length | bytes)
 */
export const BATCH_VERSION = 1;
export const BATCH_KIND_PACKETS = 1;

export function encodePackets(packets) {
  let size = 4;
  for (const packet of packets) size += 2 + packet.byteLength;
  if (packets.length > 0xffff || size > MAX_BINARY_BYTES) throw new RangeError("packet batch too large");
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out[0] = BATCH_VERSION;
  out[1] = BATCH_KIND_PACKETS;
  view.setUint16(2, packets.length, true);
  let offset = 4;
  for (const packet of packets) {
    if (packet.byteLength > MAX_PACKET_BYTES) throw new RangeError("packet too large");
    view.setUint16(offset, packet.byteLength, true);
    out.set(packet, offset + 2);
    offset += 2 + packet.byteLength;
  }
  return out;
}

/** Returns an array of Uint8Array views, or null for a malformed batch. */
export function decodePackets(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 4 || bytes[0] !== BATCH_VERSION || bytes[1] !== BATCH_KIND_PACKETS) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(2, true);
  const packets = [];
  let offset = 4;
  for (let i = 0; i < count; i += 1) {
    if (offset + 2 > bytes.byteLength) return null;
    const length = view.getUint16(offset, true);
    offset += 2;
    if (length > MAX_PACKET_BYTES || offset + length > bytes.byteLength) return null;
    packets.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return offset === bytes.byteLength ? packets : null;
}

/** Parses a text frame into a control message, or null. */
export function parseControl(text) {
  if (typeof text !== "string" || text.length > MAX_TEXT_BYTES) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.t !== "string" || value.t.length > 32) {
    return null;
  }
  return value;
}

/** Peer-to-peer control messages may use any type the relay does not reserve. */
export function isPeerMessage(message) {
  return message !== null && !RELAY_MESSAGE_TYPES.includes(message.t);
}
