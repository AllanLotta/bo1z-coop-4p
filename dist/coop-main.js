// BO1 Zombies co-op (up to 4 players) for vel.gg 2.0.0: the whole extension in one readable file
(() => {
  // extension/src/layout.js
  var BUILDS = {
    // KisakBlack-web.wasm served by https://vel.gg/bo1z/ since 2026-10-04 (9,618,325 bytes)
    "61192df377020627f52fa7e9fd28047bd53662aa46e5e3cd6e7fad0c5c35cc98": {
      // Functions patched or called by the patch: index (imports included) and expected name.
      functions: {
        svFrame: [3646, "__wrap__Z8SV_Frameii"],
        netGetLoopPacket: [4026, "NET_GetLoopPacket(netsrc_t, netadr_t*, msg_t*)"],
        cbufAddText: [291, "Cbuf_AddText(int, char const*)"],
        svWaitServer: [1391, "SV_WaitServer()"],
        // Debug-check handler: prints "KISAK_HEADLESS assert ..." then traps. In co-op it returns 1 (continue) instead.
        assertHandler: [170, "Assert_MyHandler(char const*, int, int, char const*, ...)"],
        // Attaches effects and weapons to another player's body. Fatal when that player's model is not there yet,
        // which solo play never meets; in co-op the two errors become "leave the tag as it was".
        cachedTagUpdate: [4317, "CachedTag_UpdateTagInternal(centity_s const*, cached_client_tag_t*, unsigned int, int, bool)"],
        comError: [179, "Com_Error(errorParm_t, char const*, ...)"],
        clCreateCmd: [6552, "CL_CreateCmd(usercmd_s*, int)"],
        cgScriptSndLengthNotify: [6587, "CG_ScriptSndLengthNotify(int, int)"]
      },
      // Byte edits inside one function, each matched exactly once. While a menu or the chat is open, a client marks its
      // usercmds (button_bits[1] |= 4); the server passes that on and every other client draws a "player in a menu"
      // effect whose material zombies never loads: Material_GetTechnique(null) in fx_drawCallback, a crash. So the
      // bit is never set (|= 0). Upstream co-op crashed the same way on Escape or T.
      bytePatches: [{
        fn: "clCreateCmd",
        find: [16, 220, 6, 65, 7, 70, 13, 0, 32, 5, 32, 5, 40, 2, 4, 65, 4, 114, 54, 2, 4],
        replace: [16, 220, 6, 65, 7, 70, 13, 0, 32, 5, 32, 5, 40, 2, 4, 65, 0, 114, 54, 2, 4]
      }, {
        // Guests only. A notify sound's length goes to the server as the reliable command "sl", but only from the
        // listen server's own client (com_sv_running). A guest's frozen local server still counts as running, so every
        // guest sent it too: duplicates for the host, and while the host holds its start the unacknowledged commands
        // pile up until EXE_ERR_CLIENT_CMD_OVERFLOW drops the guest. The guest's check becomes com_sv_running == 2.
        fn: "cgScriptSndLengthNotify",
        role: "guest",
        find: [65, 200, 248, 169, 192, 0, 40, 2, 0, 45, 0, 24, 65, 1, 70, 4, 64],
        replace: [65, 200, 248, 169, 192, 0, 40, 2, 0, 45, 0, 24, 65, 2, 70, 4, 64]
      }],
      // Three words of zero padding between web-layer statics, referenced by no instruction.
      // The patch uses them as cross-thread mailboxes: CMD (char* console command), FREEZE (bool), INQ (ring index).
      flags: { cmd: 148263172, freeze: 148263176, inq: 148263180 },
      // loopback_t loopbacks[2]: ring 0 = server -> local client, ring 1 = clients -> server.
      // Each ring: 16 msgs of { u8 data[1264]; i32 datalen; i32 port } then i32 get, i32 send.
      // Sends pick the ring with to.port when sock == NS_SERVER, without a bounds check: port P writes base + P * stride.
      loopback: { base: 135783616, stride: 20360, slots: 16, slotSize: 1272, dataMax: 1264, offLen: 1264, offPort: 1268, offGet: 20352, offSend: 20356 },
      // Ports 0 and 1 are the real rings; this one maps onto engine data in this build.
      forbiddenPorts: [0, 1, 1773],
      server: {
        allowNetPackets: 142494258,
        // u8 sv.allowNetPackets: the server thread drains ring 1 only while 1
        clientsPtr: 142360860,
        // client_t* svs.clients
        clientStride: 544120,
        clientState: 0,
        // i32 clientState_t: 0 free, 1 zombie, 2 reconnecting, 3 connected, 4 loading, 5 active
        clientAddrType: 32,
        // i32 netadr_t.type
        clientAddrPort: 40,
        // u16 netadr_t.port
        clientConnectState: 544089
        // u8 last connection state the client reported (10 = active)
      },
      client: {
        connectionState: 13391960,
        // i32 clientUIActive.connectionState: 5 challenging .. 10 active
        clcPtr: 43783020,
        // clientConnection_t* (serverAddress.port is a u16 at +24)
        serverAddressPort: 24,
        lastPacketTime: 12
        // i32 clc->lastPacketTime; the engine skips its connection timeout while it is 0
      },
      // Pointers to dvar_s; the current value is at +24.
      dvars: { comSvRunning: 134904904, svPaused: 134904892, clPaused: 134904896, comMaxClients: 134904752 },
      dvarValue: 24,
      browser: { mapLoadedPrinted: 148263157, introState: 148263168 },
      netadrLoopback: 2
      // NA_LOOPBACK
    }
  };
  var CONNECTION = Object.freeze({ disconnected: 0, connecting: 4, challenging: 5, connected: 6, sendingStats: 7, loading: 8, primed: 9, active: 10 });
  var CLIENT_STATE = Object.freeze({ free: 0, zombie: 1, reconnecting: 2, connected: 3, loading: 4, active: 5 });

  // extension/src/patch.js
  function uleb(n) {
    const out = [];
    do {
      let byte = n & 127;
      n >>>= 7;
      if (n) byte |= 128;
      out.push(byte);
    } while (n);
    return out;
  }
  function sleb(n) {
    const out = [];
    for (; ; ) {
      let byte = n & 127;
      n >>= 7;
      const done = n === 0 && !(byte & 64) || n === -1 && byte & 64;
      if (!done) byte |= 128;
      out.push(byte);
      if (done) return out;
    }
  }
  function readUleb(bytes, at) {
    let result = 0, shift = 0, byte;
    do {
      byte = bytes[at++];
      result |= (byte & 127) << shift;
      shift += 7;
    } while (byte & 128);
    return [result >>> 0, at];
  }
  var I32_CONST = (v) => [65, ...sleb(v | 0)];
  var LOAD = [40, 2, 0];
  var ATOMIC_LOAD = [254, 16, 2, 0];
  var ATOMIC_XCHG = [254, 65, 2, 0];
  var LOCAL_GET = (i) => [32, ...uleb(i)];
  var LOCAL_SET = (i) => [33, ...uleb(i)];
  var LOCAL_TEE = (i) => [34, ...uleb(i)];
  var CALL = (f) => [16, ...uleb(f)];
  var IF = [4, 64];
  var END = 11;
  var RETURN = 15;
  var I32_EQ = 70;
  var I32_GE_U = 79;
  function svFramePrologue(build) {
    const { flags, functions } = build;
    return [
      ...I32_CONST(flags.cmd),
      ...I32_CONST(0),
      ...ATOMIC_XCHG,
      ...LOCAL_TEE(1),
      ...IF,
      ...I32_CONST(0),
      ...LOCAL_GET(1),
      ...CALL(functions.cbufAddText[0]),
      END,
      ...I32_CONST(0),
      ...LOCAL_SET(1),
      ...I32_CONST(flags.freeze),
      ...ATOMIC_LOAD,
      ...IF,
      ...CALL(functions.svWaitServer[0]),
      ...LOCAL_GET(0),
      RETURN,
      END
    ];
  }
  function netGetLoopPacketPrologue(build) {
    const { flags, loopback } = build;
    const ring1 = loopback.base + loopback.stride;
    return [
      ...LOCAL_GET(0),
      ...I32_CONST(1),
      I32_EQ,
      ...IF,
      ...I32_CONST(flags.inq),
      ...ATOMIC_LOAD,
      ...LOCAL_TEE(4),
      ...IF,
      ...I32_CONST(ring1 + loopback.offGet),
      ...LOAD,
      ...I32_CONST(ring1 + loopback.offSend),
      ...LOAD,
      I32_GE_U,
      ...IF,
      ...LOCAL_GET(4),
      ...LOCAL_SET(0),
      END,
      END,
      ...I32_CONST(0),
      ...LOCAL_SET(4),
      END
    ];
  }
  function readSleb(bytes, at) {
    let result = 0, shift = 0, byte;
    do {
      byte = bytes[at++];
      result |= (byte & 127) << shift;
      shift += 7;
    } while (byte & 128);
    if (shift < 32 && byte & 64) result |= -1 << shift;
    return [result, at];
  }
  function nonFatalAssert(body, params) {
    let [groups, p] = readUleb(body, 0);
    for (let g = 0; g < groups; g += 1) p = readUleb(body, p)[1] + 1;
    const fail = (why) => {
      throw new Error(`assert handler: ${why}`);
    };
    if (body[p] !== 35) fail("no stack frame");
    const [sp, a] = readUleb(body, p + 1);
    if (body[a] !== 65) fail("no frame size");
    const [frame, b] = readSleb(body, a + 1);
    if (body[b] !== 107 || body[b + 1] !== 34) fail("unexpected prologue");
    const [frameLocal, c] = readUleb(body, b + 2);
    if (frameLocal < params || body[c] !== 36 || readUleb(body, c + 1)[0] !== sp) fail("unexpected prologue");
    const end = body.length;
    if (body[end - 1] !== 11 || body[end - 2] !== 0) fail("does not end with unreachable");
    const tail = [...LOCAL_GET(frameLocal), ...I32_CONST(frame), 106, 36, ...uleb(sp), ...I32_CONST(1), RETURN, END];
    const out = new Uint8Array(end - 2 + tail.length);
    out.set(body.subarray(0, end - 2), 0);
    out.set(tail, end - 2);
    return out;
  }
  function neutralizeCalls(body, callee, args, expected) {
    const pattern = Uint8Array.from([16, ...uleb(callee)]);
    const out = Uint8Array.from(body);
    let found = 0;
    for (let i = 0; i + pattern.length <= out.length; i += 1) {
      if (pattern.every((byte, k) => out[i + k] === byte)) {
        if (pattern.length !== args) throw new Error("neutralizeCalls: call and drops differ in size");
        for (let k = 0; k < args; k += 1) out[i + k] = 26;
        found += 1;
        i += pattern.length - 1;
      }
    }
    if (found !== expected) throw new Error(`neutralizeCalls: found ${found} calls, expected ${expected}`);
    return out;
  }
  function replaceOnce(body, { fn, find, replace }) {
    if (find.length !== replace.length) throw new Error(`byte patch ${fn}: sizes differ`);
    const out = Uint8Array.from(body);
    let at = -1, found = 0;
    for (let i = 0; i + find.length <= out.length; i += 1) {
      if (find.every((byte, k) => out[i + k] === byte)) {
        at = i;
        found += 1;
      }
    }
    if (found !== 1) throw new Error(`byte patch ${fn}: found ${found} matches, expected 1`);
    out.set(replace, at);
    return out;
  }
  function inspectWasm(bytes) {
    if (bytes[0] !== 0 || bytes[1] !== 97 || bytes[2] !== 115 || bytes[3] !== 109) throw new Error("not a wasm module");
    const sections = [];
    let importedFunctions = 0, nameSection = null;
    let at = 8;
    while (at < bytes.length) {
      const id = bytes[at];
      const [size, body] = readUleb(bytes, at + 1);
      const section = { id, start: at, body, end: body + size };
      sections.push(section);
      if (id === 2) importedFunctions = countImportedFunctions(bytes, body);
      if (id === 0) {
        const [nameLength, nameAt] = readUleb(bytes, body);
        if (new TextDecoder().decode(bytes.subarray(nameAt, nameAt + nameLength)) === "name") nameSection = { at: nameAt + nameLength, end: section.end };
      }
      at = section.end;
    }
    return { sections, importedFunctions, nameSection };
  }
  function countImportedFunctions(bytes, at) {
    let [count, p] = readUleb(bytes, at);
    let functions = 0;
    for (let i = 0; i < count; i += 1) {
      let length;
      [length, p] = readUleb(bytes, p);
      p += length;
      [length, p] = readUleb(bytes, p);
      p += length;
      const kind = bytes[p++];
      if (kind === 0) {
        functions += 1;
        p = readUleb(bytes, p)[1];
      } else if (kind === 1) {
        p += 1;
        const limits = bytes[p++];
        p = readUleb(bytes, p)[1];
        if (limits & 1) p = readUleb(bytes, p)[1];
      } else if (kind === 2) {
        const limits = bytes[p++];
        p = readUleb(bytes, p)[1];
        if (limits & 1) p = readUleb(bytes, p)[1];
      } else if (kind === 3) p += 2;
      else if (kind === 4) {
        p += 1;
        p = readUleb(bytes, p)[1];
      } else throw new Error(`unknown import kind ${kind}`);
    }
    return functions;
  }
  function functionNames(bytes, nameSection, wanted) {
    const names = /* @__PURE__ */ new Map();
    if (!nameSection) return names;
    const want = new Set(wanted);
    let at = nameSection.at;
    while (at < nameSection.end) {
      const kind = bytes[at++];
      const [size, body] = readUleb(bytes, at);
      if (kind === 1) {
        let [count, p] = readUleb(bytes, body);
        for (let i = 0; i < count && names.size < want.size; i += 1) {
          let index, length;
          [index, p] = readUleb(bytes, p);
          [length, p] = readUleb(bytes, p);
          if (want.has(index)) names.set(index, new TextDecoder().decode(bytes.subarray(p, p + length)));
          p += length;
        }
      }
      at = body + size;
    }
    return names;
  }
  function patchEngine(input, hash, build = BUILDS[hash], role = null) {
    if (!build) throw new Error(`unknown engine build ${hash?.slice(0, 12)}`);
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const { sections, importedFunctions, nameSection } = inspectWasm(bytes);
    const indices = Object.values(build.functions).map(([index]) => index);
    const names = functionNames(bytes, nameSection, indices);
    for (const [index, expected] of Object.values(build.functions)) {
      if (names.get(index) !== expected) throw new Error(`function ${index} is ${names.get(index)}, expected ${expected}`);
    }
    const code = sections.find((section) => section.id === 10);
    const targets = /* @__PURE__ */ new Map([
      [build.functions.svFrame[0] - importedFunctions, [svFramePrologue(build), 1, 1]],
      [build.functions.netGetLoopPacket[0] - importedFunctions, [netGetLoopPacketPrologue(build), 3, 4]]
    ]);
    const byteTargets = new Map((build.bytePatches ?? []).filter((patch) => !patch.role || patch.role === role).map((patch) => [build.functions[patch.fn][0] - importedFunctions, patch]));
    const assertIndex = build.functions.assertHandler ? build.functions.assertHandler[0] - importedFunctions : -1;
    const cachedTagIndex = build.functions.cachedTagUpdate && build.functions.comError ? build.functions.cachedTagUpdate[0] - importedFunctions : -1;
    let [count, at] = readUleb(bytes, code.body);
    const parts = [Uint8Array.from(uleb(count))];
    let patched = 0;
    for (let i = 0; i < count; i += 1) {
      const [size, bodyStart] = readUleb(bytes, at);
      const bodyEnd = bodyStart + size;
      const target = targets.get(i);
      if (assertIndex === i) {
        const body = nonFatalAssert(bytes.subarray(bodyStart, bodyEnd), 4);
        parts.push(Uint8Array.from(uleb(body.length)), body);
        patched += 1;
      } else if (cachedTagIndex === i) {
        const body = neutralizeCalls(bytes.subarray(bodyStart, bodyEnd), build.functions.comError[0], 3, 2);
        parts.push(Uint8Array.from(uleb(body.length)), body);
        patched += 1;
      } else if (byteTargets.has(i)) {
        const body = replaceOnce(bytes.subarray(bodyStart, bodyEnd), byteTargets.get(i));
        parts.push(Uint8Array.from(uleb(body.length)), body);
        patched += 1;
      } else if (target) {
        const [prologue, params, scratch] = target;
        let [groups, p] = readUleb(bytes, bodyStart);
        let next = params, scratchType = null;
        for (let g = 0; g < groups; g += 1) {
          let n;
          [n, p] = readUleb(bytes, p);
          if (scratch >= next && scratch < next + n) scratchType = bytes[p];
          next += n;
          p += 1;
        }
        if (scratchType !== 127) throw new Error(`patch target ${i + importedFunctions}: local ${scratch} is not an i32`);
        const body = new Uint8Array(size + prologue.length);
        body.set(bytes.subarray(bodyStart, p), 0);
        body.set(prologue, p - bodyStart);
        body.set(bytes.subarray(p, bodyEnd), p - bodyStart + prologue.length);
        parts.push(Uint8Array.from(uleb(body.length)), body);
        patched += 1;
      } else {
        parts.push(bytes.subarray(at, bodyEnd));
      }
      at = bodyEnd;
    }
    if (patched !== targets.size + byteTargets.size + (assertIndex >= 0 ? 1 : 0) + (cachedTagIndex >= 0 ? 1 : 0)) throw new Error("patch targets not found");
    const bodyLength = parts.reduce((sum, part) => sum + part.length, 0);
    const header = Uint8Array.from([10, ...uleb(bodyLength)]);
    const out = new Uint8Array(code.start + header.length + bodyLength + (bytes.length - code.end));
    out.set(bytes.subarray(0, code.start), 0);
    let o = code.start;
    out.set(header, o);
    o += header.length;
    for (const part of parts) {
      out.set(part, o);
      o += part.length;
    }
    out.set(bytes.subarray(code.end), o);
    return out;
  }
  async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // extension/src/rings.js
  function ringOffsets(layout, index) {
    const lb = layout.loopback;
    const base = lb.base + index * lb.stride;
    return { base, get: base + lb.offGet, send: base + lb.offSend };
  }

  // extension/src/engine-mem.js
  var EngineMemory = class {
    constructor(Module, layout) {
      this.Module = Module;
      this.layout = layout;
      this.memory = Module.HEAPF32.buffer;
      this.i32 = new Int32Array(this.memory);
      this.u16 = new Uint16Array(this.memory);
      this.u8 = new Uint8Array(this.memory);
      this.commandBuffer = 0;
    }
    int(address) {
      return Atomics.load(this.i32, address >> 2);
    }
    setInt(address, value) {
      Atomics.store(this.i32, address >> 2, value);
    }
    byte(address) {
      return Atomics.load(this.u8, address);
    }
    dvarInt(name) {
      const dvar = this.int(this.layout.dvars[name]);
      return dvar ? this.int(dvar + this.layout.dvarValue) : null;
    }
    setDvarInt(name, value) {
      const dvar = this.int(this.layout.dvars[name]);
      if (dvar) this.setInt(dvar + this.layout.dvarValue, value);
      return Boolean(dvar);
    }
    mailboxesClear() {
      const { cmd, freeze, inq } = this.layout.flags;
      return this.int(cmd) === 0 && this.int(freeze) === 0 && this.int(inq) === 0;
    }
    /** Queues one console command for the engine main thread; false while the previous one is pending. */
    command(text) {
      const { cmd } = this.layout.flags;
      if (this.int(cmd) !== 0) return false;
      const bytes = new TextEncoder().encode(`${text}
`);
      if (bytes.length >= 1024) throw new RangeError("command too long");
      if (!this.commandBuffer) this.commandBuffer = this.Module._malloc(1024);
      this.u8.set(bytes, this.commandBuffer);
      this.u8[this.commandBuffer + bytes.length] = 0;
      return Atomics.compareExchange(this.i32, cmd >> 2, 0, this.commandBuffer) === 0;
    }
    commandPending() {
      return this.int(this.layout.flags.cmd) !== 0;
    }
    setFreeze(on) {
      this.setInt(this.layout.flags.freeze, on ? 1 : 0);
    }
    serverDrainsPackets() {
      return this.byte(this.layout.server.allowNetPackets) === 1;
    }
    serverRunning() {
      const dvar = this.int(this.layout.dvars.comSvRunning);
      return dvar ? this.byte(dvar + this.layout.dvarValue) === 1 : false;
    }
    connectionState() {
      return this.int(this.layout.client.connectionState);
    }
    /** Points the local client's server address at loopback port 0, where the page injects the host's packets. */
    setServerAddressPort(port) {
      const clc = this.int(this.layout.client.clcPtr);
      if (!clc) return false;
      Atomics.store(this.u16, clc + this.layout.client.serverAddressPort >> 1, port);
      return true;
    }
    /** Zeroes the client's last-packet time: the engine skips its connection timeout while it is 0. */
    clearLastPacketTime() {
      const clc = this.int(this.layout.client.clcPtr);
      if (clc) this.setInt(clc + this.layout.client.lastPacketTime, 0);
    }
    /** A game menu (pause menu, options, ...) owns the cursor. */
    menuOpen() {
      return Boolean(this.Module._KB_UIState?.() & 1);
    }
    serverAddressPort() {
      const clc = this.int(this.layout.client.clcPtr);
      return clc ? Atomics.load(this.u16, clc + this.layout.client.serverAddressPort >> 1) : null;
    }
    /** Server slots in use: [{ slot, state, loopback, port, connectState }]. */
    serverClients() {
      const s = this.layout.server;
      const clients = this.int(s.clientsPtr);
      const count = this.dvarInt("comMaxClients") ?? 0;
      const out = [];
      if (!clients) return out;
      for (let slot = 0; slot < Math.min(count, 64); slot += 1) {
        const base = clients + slot * s.clientStride;
        const state = this.int(base + s.clientState);
        if (state === CLIENT_STATE.free) continue;
        out.push({
          slot,
          state,
          loopback: this.int(base + s.clientAddrType) === this.layout.netadrLoopback,
          port: Atomics.load(this.u16, base + s.clientAddrPort >> 1),
          connectState: this.byte(base + s.clientConnectState)
        });
      }
      return out;
    }
    /**
     * Host: rings the engine knows nothing about, inside one malloc'd block. The server sends to loopback port P by
     * writing loopbacks[P] = base + P * stride, so P is picked to land in the block. Guest seat s (1..guests) gets
     * port P + s - 1, its own outbound ring; port P + guests is the inbound ring the patched NET_GetLoopPacket
     * drains, shared by every guest (each packet carries its sender's port). Never freed.
     */
    allocateRemoteRings(guests = MAX_GUESTS) {
      const lb = this.layout.loopback;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const size = (guests + 2) * lb.stride + 64;
        const block = this.Module._malloc(size);
        if (!block) throw new Error("out of engine memory");
        this.u8.fill(0, block, block + size);
        const first = Math.ceil((block - lb.base) / lb.stride);
        const inPort = first + guests;
        const ports = Array.from({ length: guests }, (_, i) => first + i);
        const fits = lb.base + (inPort + 1) * lb.stride <= block + size;
        const allowed = ![...ports, inPort].some((p) => this.layout.forbiddenPorts.includes(p));
        if (first >= 2 && inPort <= 65535 && fits && allowed) {
          const seats = {};
          ports.forEach((port, i) => seats[i + 1] = { port, out: ringOffsets(this.layout, port) });
          return { seats, inPort, in: ringOffsets(this.layout, inPort) };
        }
      }
      throw new Error("could not place the co-op rings in engine memory");
    }
    setInboundRing(index) {
      this.setInt(this.layout.flags.inq, index);
    }
  };

  // shared/protocol.js
  var ROLES = Object.freeze(["host", "guest"]);
  var RELAY_MESSAGE_TYPES = Object.freeze(["welcome", "peer", "error"]);
  var ROOM_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
  var ROOM_CODE_LENGTH = 16;
  var MAX_GUESTS = 3;
  function createGuestId(random = (bytes) => crypto.getRandomValues(bytes)) {
    let id = "";
    for (const byte of random(new Uint8Array(16))) id += ROOM_ALPHABET[byte & 31];
    return id;
  }
  function createRoomCode(random = (bytes) => crypto.getRandomValues(bytes)) {
    const bytes = random(new Uint8Array(ROOM_CODE_LENGTH));
    let code = "";
    for (const byte of bytes) code += ROOM_ALPHABET[byte & 31];
    return code.match(/.{4}/g).join("-");
  }
  function normalizeRoomCode(input) {
    if (typeof input !== "string") return null;
    let text = input.trim();
    try {
      const url = new URL(text);
      text = url.searchParams.get("room") ?? "";
    } catch {
    }
    const compact = text.toLowerCase().replace(/[^0-9a-z]/g, "");
    if (compact.length !== ROOM_CODE_LENGTH || [...compact].some((c) => !ROOM_ALPHABET.includes(c))) return null;
    return compact.match(/.{4}/g).join("-");
  }

  // extension/src/strings.js
  var LANG = /^pt\b/i.test(navigator.language ?? "") ? "pt" : "en";
  var STRINGS = {
    en: {
      tagline: "up to 4 players",
      chip: { solo: "Solo", hosting: "Hosting", joining: "Joining", lobby: "Lobby", ingame: "In game", paused: "Paused", offline: "Offline", error: "Error", ended: "Disconnected" },
      intro: "Play zombies with up to 3 friends. One player hosts, the others join with the invite link. Everyone needs this extension.",
      host: "Host a game",
      joinLabel: "Join a friend",
      joinPlaceholder: "Room code or invite link",
      join: "Join",
      room: "Room",
      inviteAside: (n) => `${n} free seat${n === 1 ? "" : "s"}`,
      copy: "Copy link",
      copyCode: "Copy code",
      copied: "Copied!",
      players: "Lobby",
      playersAside: (n, max) => `${n}/${max} connected`,
      freeHint: "Send someone the link",
      player: (n) => `Player ${n}`,
      you: "you",
      hostTag: "host",
      st: {
        free: "Free seat", left: "Left", reconnecting: "Reconnecting…", disconnected: "Disconnected \xB7 can rejoin", ingame: "In game", ready: "Ready",
        joining: "Joining…", turn: "Next in line", loading: "Loading the map…", picking: "Picking a map", lobby: "In the lobby", opening: "Opening the room…", unknown: "Not in the room"
      },
      map: "Map",
      noMap: "Not picked yet",
      mapSubHost: "Everyone follows you to this map",
      mapSubGuest: "Picked by the host",
      hell: "Hell mode",
      stepsGuest: ["Room", "Map", "Load", "Join", "Play"],
      stepsHost: ["Map", "Load", "Lobby", "Play"],
      pickMap: "Pick a map in the game menu. Everyone follows you to it.",
      gate: "Players are on the way. Your start waits for them, so everyone spawns together.",
      startNow: "Start now",
      allIn: "Everyone is in. Click the game to start.",
      latecomers: "Players who join after the start watch until the next round (the BO1 rule for latecomers).",
      pausedYou: "Paused. Everyone is paused too.",
      pausedBy: "Paused by another player.",
      waitingHost: "Waiting for the host…",
      hostPicking: "Waiting for the host to pick a map…",
      opening: (m) => `Opening ${m}…`,
      pressKey: "Press any key on the page to load the map.",
      loadingMap: "Loading the map…",
      hostLoading: "Waiting for the host to finish loading…",
      nextInLine: "Another player is joining. You are next.",
      connecting: "Connecting to the host…",
      joiningGame: "Joining the host's game…",
      waitingStart: "You are in. Waiting for the host to start.",
      clickToPlay: "You are in. Click the game to play.",
      lateJoin: "The host had already started: you watch until the next round, then spawn.",
      ended: "Disconnected from the host. You can rejoin while the host keeps playing.",
      failed: "Could not join. Try again.",
      rejoin: "Rejoin",
      goToHost: "Go to the host",
      leave: "Leave co-op",
      otherRelay: (h) => `This invite uses another relay (${h}). Switch to it to join.`,
      useRelay: "Use this relay",
      settings: "Settings",
      yourName: "Your name",
      namePlaceholder: "Shown in the lobby",
      save: "Save",
      connection: "Connection",
      relay: "Relay",
      relayState: { open: "Connected", connecting: "Connecting…", closed: "Reconnecting…", idle: "Starting…" },
      ping: "Ping",
      dropped: "Packets dropped",
      relayDefault: "Group relay (4P)",
      relayCustom: (h) => `Custom (${h})`,
      relayNote: "Free Cloudflare plan: a daily allowance shared by everyone on this relay.",
      changeRelay: "Change relay",
      useDefault: "Use the default relay",
      cancel: "Cancel",
      relayEditNote: "Everyone must use the same relay. Your invite links carry it.",
      relayPlaceholder: "https://your-relay.workers.dev",
      usage: (p, t) => `Today: ${p}% of the free allowance used \xB7 resets at ${t}`,
      usedUp: (t) => `Today's allowance is used up \xB7 resets at ${t}`,
      controller: "Controller",
      ctrl: { off: "Off", unavailable: "Unavailable", press: "Press any button on it", later: (n) => `${n} \xB7 works in game`, active: (n, a, max) => `${n} \xB7 aim ${a}/${max}` },
      aimDown: "Aim −",
      aimUp: "Aim +",
      turnOff: "Turn off",
      turnOn: "Turn on",
      credits: "vel.gg by MisaDev4 \xB7 co-op by invictus841 \xB7 4P fork",
      notRoomCode: "That is not a room code. Paste the invite link or the 16-letter code.",
      notRelay: "That is not a relay address. It looks like https://something.workers.dev",
      controllerReload: "Reload the page to apply the controller setting.",
      engineUpdated: "vel.gg updated its game engine, and this version of the extension does not know it yet: co-op and the controller are off.",
      enginePatchFailed: (m) => `Could not prepare the engine (${m}): co-op and the controller are off.`,
      replaced: "This room was opened in another tab or window.",
      full: (n) => `This game is full (${n} players).`,
      workerFailed: (m) => `Co-op worker failed: ${m}`,
      unexpectedMemory: "Unexpected engine memory: co-op is off.",
      hostNoAnswer: "The host did not answer. Check that their game page is open, then reload.",
      versionMismatch: "You and the host have different versions of the game. Reload both pages.",
      hostPlaying: (m) => `The host is playing ${m}. Reload this page.`,
      connectFailed: "Could not start the connection to the host. Reload both pages.",
      notLetIn: "The host did not let us in. Reload both pages and try again.",
      hostLeft: "The host left the game."
    },
    pt: {
      tagline: "at\xE9 4 jogadores",
      chip: { solo: "Solo", hosting: "Hospedando", joining: "Entrando", lobby: "Lobby", ingame: "Em jogo", paused: "Pausado", offline: "Offline", error: "Erro", ended: "Desconectado" },
      intro: "Jogue zombies com at\xE9 3 amigos. Um jogador hospeda e os outros entram pelo link de convite. Todos precisam desta extens\xE3o.",
      host: "Hospedar partida",
      joinLabel: "Entrar na partida de um amigo",
      joinPlaceholder: "C\xF3digo da sala ou link",
      join: "Entrar",
      room: "Sala",
      inviteAside: (n) => `${n} vaga${n === 1 ? "" : "s"} livre${n === 1 ? "" : "s"}`,
      copy: "Copiar link",
      copyCode: "Copiar c\xF3digo",
      copied: "Copiado!",
      players: "Lobby",
      playersAside: (n, max) => `${n}/${max} conectados`,
      freeHint: "Mande o link para algu\xE9m",
      player: (n) => `Jogador ${n}`,
      you: "voc\xEA",
      hostTag: "host",
      st: {
        free: "Vaga livre", left: "Saiu", reconnecting: "Reconectando…", disconnected: "Desconectou \xB7 pode voltar", ingame: "Em jogo", ready: "Pronto",
        joining: "Entrando…", turn: "Na fila para entrar", loading: "Carregando o mapa…", picking: "Escolhendo o mapa", lobby: "No lobby", opening: "Abrindo a sala…", unknown: "Fora da sala"
      },
      map: "Mapa",
      noMap: "Ainda n\xE3o escolhido",
      mapSubHost: "Todos v\xE3o seguir voc\xEA para este mapa",
      mapSubGuest: "Escolhido pelo host",
      hell: "Hell mode",
      stepsGuest: ["Sala", "Mapa", "Carregar", "Entrar", "Jogar"],
      stepsHost: ["Mapa", "Carregar", "Lobby", "Jogar"],
      pickMap: "Escolha um mapa no menu do jogo. Todos v\xE3o seguir voc\xEA.",
      gate: "Tem jogadores a caminho. Seu in\xEDcio espera por eles, para todos nascerem juntos.",
      startNow: "Come\xE7ar agora",
      allIn: "Todos entraram. Clique no jogo para come\xE7ar.",
      latecomers: "Quem entrar depois do in\xEDcio assiste at\xE9 a pr\xF3xima rodada (regra do BO1 para quem chega atrasado).",
      pausedYou: "Pausado. Todos est\xE3o pausados tamb\xE9m.",
      pausedBy: "Pausado por outro jogador.",
      waitingHost: "Esperando o host…",
      hostPicking: "Esperando o host escolher o mapa…",
      opening: (m) => `Abrindo ${m}…`,
      pressKey: "Aperte qualquer tecla na p\xE1gina para carregar o mapa.",
      loadingMap: "Carregando o mapa…",
      hostLoading: "Esperando o host terminar de carregar…",
      nextInLine: "Outro jogador est\xE1 entrando. Voc\xEA \xE9 o pr\xF3ximo.",
      connecting: "Conectando ao host…",
      joiningGame: "Entrando na partida do host…",
      waitingStart: "Voc\xEA entrou. Esperando o host come\xE7ar.",
      clickToPlay: "Voc\xEA entrou. Clique no jogo para jogar.",
      lateJoin: "O host j\xE1 tinha come\xE7ado: voc\xEA assiste at\xE9 a pr\xF3xima rodada e ent\xE3o nasce.",
      ended: "Desconectado do host. Voc\xEA pode voltar enquanto o host continuar jogando.",
      failed: "N\xE3o deu para entrar. Tente de novo.",
      rejoin: "Voltar para a partida",
      goToHost: "Ir at\xE9 o host",
      leave: "Sair do co-op",
      otherRelay: (h) => `Este convite usa outro relay (${h}). Troque para ele para entrar.`,
      useRelay: "Usar este relay",
      settings: "Configura\xE7\xF5es",
      yourName: "Seu nome",
      namePlaceholder: "Aparece no lobby",
      save: "Salvar",
      connection: "Conex\xE3o",
      relay: "Relay",
      relayState: { open: "Conectado", connecting: "Conectando…", closed: "Reconectando…", idle: "Iniciando…" },
      ping: "Ping",
      dropped: "Pacotes perdidos",
      relayDefault: "Relay do grupo (4P)",
      relayCustom: (h) => `Personalizado (${h})`,
      relayNote: "Plano gr\xE1tis da Cloudflare: uma cota di\xE1ria dividida por todos que usam este relay.",
      changeRelay: "Trocar relay",
      useDefault: "Usar o relay padr\xE3o",
      cancel: "Cancelar",
      relayEditNote: "Todos precisam usar o mesmo relay. Seus links de convite j\xE1 levam ele.",
      relayPlaceholder: "https://seu-relay.workers.dev",
      usage: (p, t) => `Hoje: ${p}% da cota gr\xE1tis usada \xB7 renova \xE0s ${t}`,
      usedUp: (t) => `Cota de hoje esgotada \xB7 renova \xE0s ${t}`,
      controller: "Controle",
      ctrl: { off: "Desligado", unavailable: "Indispon\xEDvel", press: "Aperte qualquer bot\xE3o nele", later: (n) => `${n} \xB7 funciona no jogo`, active: (n, a, max) => `${n} \xB7 mira ${a}/${max}` },
      aimDown: "Mira −",
      aimUp: "Mira +",
      turnOff: "Desligar",
      turnOn: "Ligar",
      credits: "vel.gg por MisaDev4 \xB7 co-op por invictus841 \xB7 fork 4P",
      notRoomCode: "Isso n\xE3o \xE9 um c\xF3digo de sala. Cole o link de convite ou o c\xF3digo de 16 letras.",
      notRelay: "Isso n\xE3o \xE9 um endere\xE7o de relay. Ele parece com https://algo.workers.dev",
      controllerReload: "Recarregue a p\xE1gina para aplicar a configura\xE7\xE3o do controle.",
      engineUpdated: "O vel.gg atualizou o motor do jogo e esta vers\xE3o da extens\xE3o ainda n\xE3o o conhece: co-op e controle desligados.",
      enginePatchFailed: (m) => `N\xE3o deu para preparar o motor do jogo (${m}): co-op e controle desligados.`,
      replaced: "Esta sala foi aberta em outra aba ou janela.",
      full: (n) => `Esta partida est\xE1 cheia (${n} jogadores).`,
      workerFailed: (m) => `O worker do co-op falhou: ${m}`,
      unexpectedMemory: "Mem\xF3ria do motor inesperada: co-op desligado.",
      hostNoAnswer: "O host n\xE3o respondeu. Confira se a p\xE1gina do jogo dele est\xE1 aberta e recarregue.",
      versionMismatch: "Voc\xEA e o host est\xE3o com vers\xF5es diferentes do jogo. Recarreguem as duas p\xE1ginas.",
      hostPlaying: (m) => `O host est\xE1 jogando ${m}. Recarregue esta p\xE1gina.`,
      connectFailed: "N\xE3o deu para iniciar a conex\xE3o com o host. Recarreguem as duas p\xE1ginas.",
      notLetIn: "O host n\xE3o deixou entrar. Recarreguem as duas p\xE1ginas e tentem de novo.",
      hostLeft: "O host saiu da partida."
    }
  };
  var T = STRINGS[LANG];
  var MAP_GLYPHS = { five: "5", kino: "K", riese: "R", nacht: "N", verruckt: "V", shinonuma: "S", ascension: "A", cotd: "C", shangrila: "L", moon: "M" };


  // extension/src/ui.js
  // Player colours as on the BO1 zombies scoreboard: white, blue, yellow, green.
  var PLAYER_COLORS = ["#f2efe9", "#5aa8ff", "#f4c542", "#63d471"];
  var STYLE = `
:host { all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483647; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg);
  --bg: #121110; --bg2: #1b1917; --bg3: #24211e; --line: #34302b; --fg: #ece6dc; --muted: #9d958a; --dim: #6f685f;
  --accent: #e2552f; --accent2: #f07a4f; --ok: #63d471; --wait: #f4c542; --bad: #ff6b5a; }
* { box-sizing: border-box; }
.card { width: 312px; max-height: calc(100vh - 24px); overflow: auto; background: var(--bg); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0,0,0,.55); scrollbar-width: thin; scrollbar-color: var(--line) transparent; }
.head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; background: linear-gradient(180deg, #1d1a17, var(--bg)); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 1; }
.mark { display: grid; grid-template-columns: 6px 6px; gap: 2px; flex: none; }
.mark i { width: 6px; height: 6px; border-radius: 1.5px; opacity: .9; }
.title { flex: 1; min-width: 0; }
.title b { display: block; font-size: 13px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; }
.title span { display: block; font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip { flex: none; font-size: 11px; font-weight: 700; padding: 3px 8px; border-radius: 99px; background: var(--bg3); color: var(--muted); border: 1px solid var(--line); white-space: nowrap; }
.chip.ok { color: var(--ok); border-color: rgba(99,212,113,.35); background: rgba(99,212,113,.08); }
.chip.wait { color: var(--wait); border-color: rgba(244,197,66,.35); background: rgba(244,197,66,.08); }
.chip.bad { color: var(--bad); border-color: rgba(255,107,90,.4); background: rgba(255,107,90,.08); }
.chip.live::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 5px; vertical-align: 1px; animation: pulse 1.6s ease-in-out infinite; }
@keyframes pulse { 50% { opacity: .25; } }
button.icon { all: unset; cursor: pointer; color: var(--muted); width: 22px; height: 22px; display: grid; place-items: center; border-radius: 5px; font-size: 15px; }
button.icon:hover { background: var(--bg3); color: var(--fg); }
.body { padding: 12px; display: grid; gap: 10px; }
:host(.collapsed) .body { display: none; }
:host(.collapsed) .head { border-bottom: 0; }
.muted { color: var(--muted); } .small { font-size: 12px; } .error { color: var(--bad); }
.label { font-size: 10.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); margin-bottom: 6px; display: flex; justify-content: space-between; align-items: baseline; }
.label em { font-style: normal; letter-spacing: 0; text-transform: none; font-weight: 600; color: var(--muted); font-size: 11px; }
.panel { background: var(--bg2); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
.panel .code { font: 700 17px/1.2 ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: .05em; color: #fff; user-select: all; white-space: nowrap; margin-bottom: 9px; }
.map { display: flex; align-items: center; gap: 10px; }
.map .glyph { width: 34px; height: 34px; border-radius: 6px; flex: none; display: grid; place-items: center; background: radial-gradient(circle at 30% 30%, #3a2a22, #1a1411); border: 1px solid #4a3328; color: var(--accent2); font-weight: 900; font-size: 15px; }
.map .name { font-weight: 700; font-size: 14px; }
.map .sub { font-size: 11.5px; color: var(--muted); }
.tag { display: inline-block; font-size: 9.5px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; padding: 1px 5px; border-radius: 4px; vertical-align: 1px; margin-left: 5px; }
.tag.host { background: rgba(226,85,47,.18); color: var(--accent2); }
.tag.you { background: rgba(255,255,255,.1); color: var(--fg); }
.tag.hell { background: rgba(255,107,90,.15); color: var(--bad); }
.players { display: grid; gap: 6px; }
.player { display: flex; align-items: center; gap: 10px; padding: 7px 9px; border-radius: 7px; background: var(--bg3); border: 1px solid transparent; }
.player.me { border-color: var(--line); }
.player.empty { background: transparent; border: 1px dashed var(--line); }
.badge { width: 26px; height: 26px; border-radius: 50%; flex: none; display: grid; place-items: center; font-weight: 800; font-size: 12px; color: #111; position: relative; }
.player.empty .badge { background: transparent !important; color: var(--dim); box-shadow: inset 0 0 0 1.5px var(--line); }
.who { flex: 1; min-width: 0; }
.who .name { font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.player.empty .who .name { color: var(--dim); font-weight: 500; }
.who .st { font-size: 11.5px; color: var(--muted); display: flex; align-items: center; gap: 5px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dim); flex: none; }
.dot.ok { background: var(--ok); } .dot.wait { background: var(--wait); animation: pulse 1.6s ease-in-out infinite; } .dot.bad { background: var(--bad); }
.ping { flex: none; text-align: right; font: 600 11px ui-monospace, Menlo, monospace; color: var(--muted); display: grid; justify-items: end; gap: 2px; }
.bars { display: flex; gap: 2px; align-items: flex-end; height: 10px; }
.bars i { width: 3px; border-radius: 1px; background: var(--line); }
.bars i:nth-child(1) { height: 4px; } .bars i:nth-child(2) { height: 7px; } .bars i:nth-child(3) { height: 10px; }
.bars.q3 i { background: var(--ok); } .bars.q2 i:nth-child(-n+2) { background: var(--wait); } .bars.q1 i:nth-child(1) { background: var(--bad); }
.steps { display: flex; align-items: flex-start; }
.step { flex: 1; display: grid; justify-items: center; gap: 4px; position: relative; font-size: 10.5px; color: var(--dim); text-align: center; }
.step::before { content: ""; position: absolute; top: 6px; left: -50%; width: 100%; height: 2px; background: var(--line); z-index: 0; }
.step:first-child::before { display: none; }
.step i { width: 14px; height: 14px; border-radius: 50%; background: var(--bg); border: 2px solid var(--line); z-index: 1; }
.step.done { color: var(--muted); } .step.done::before { background: var(--accent); } .step.done i { background: var(--accent); border-color: var(--accent); }
.step.now { color: var(--fg); font-weight: 700; } .step.now::before { background: var(--accent); } .step.now i { border-color: var(--accent2); box-shadow: 0 0 0 3px rgba(226,85,47,.25); }
.step.now.fail i { border-color: var(--bad); box-shadow: 0 0 0 3px rgba(255,107,90,.2); }
.call { border-radius: 8px; padding: 9px 10px; background: var(--bg2); border: 1px solid var(--line); border-left: 3px solid var(--muted); display: grid; gap: 8px; }
.call.info { border-left-color: #5aa8ff; } .call.ok { border-left-color: var(--ok); } .call.wait { border-left-color: var(--wait); } .call.bad { border-left-color: var(--bad); background: rgba(255,107,90,.06); }
.call b { font-weight: 700; }
.row { display: flex; gap: 6px; } .row > * { flex: 1; }
button.act { all: unset; box-sizing: border-box; text-align: center; cursor: pointer; padding: 8px 10px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg3); color: var(--fg); font-weight: 650; font-size: 12.5px; transition: background .12s, border-color .12s; }
button.act:hover, button.act:focus-visible { background: #2e2a26; border-color: #4a443d; }
button.act.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.act.primary:hover { background: var(--accent2); border-color: var(--accent2); }
button.act.ghost { background: transparent; color: var(--muted); }
button.act.ghost:hover { color: var(--fg); }
button.act.done { background: rgba(99,212,113,.15); border-color: rgba(99,212,113,.4); color: var(--ok); }
button.act.slim { flex: 0 0 auto; padding: 6px 10px; }
button.act[disabled] { opacity: .5; cursor: default; }
input { all: unset; box-sizing: border-box; padding: 7px 9px; border: 1px solid var(--line); border-radius: 7px; background: #0c0b0a; color: var(--fg); font: 12.5px ui-monospace, Menlo, monospace; min-width: 0; flex: 1; }
input:focus { border-color: var(--accent); }
input::placeholder { color: var(--dim); }
.kv { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 12px; margin: 0; }
.kv dt { color: var(--muted); } .kv dd { margin: 0; text-align: right; }
.meter { height: 5px; border-radius: 3px; background: var(--bg3); overflow: hidden; margin-top: 5px; }
.meter > span { display: block; height: 100%; background: var(--ok); }
.meter.warn > span { background: var(--wait); } .meter.full > span { background: var(--bad); }
.section { border-top: 1px solid var(--line); padding-top: 10px; display: grid; gap: 10px; }
.section > button.toggle { all: unset; cursor: pointer; display: flex; justify-content: space-between; align-items: center; font-size: 10.5px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; color: var(--dim); }
.section > button.toggle:hover { color: var(--muted); }
.section > button.toggle::after { content: "\\25BE"; font-size: 12px; transition: transform .15s; }
.section.closed > button.toggle::after { transform: rotate(-90deg); }
.credits { font-size: 11px; color: var(--dim); text-align: center; }
.pill { display: none; }
:host(.compact) .card { display: none; }
:host(.compact) .pill { display: flex; align-items: center; gap: 8px; pointer-events: none; background: rgba(12,11,10,.72); border: 1px solid rgba(255,255,255,.08); border-radius: 99px; padding: 4px 10px; font: 600 11.5px system-ui, sans-serif; color: #ddd; backdrop-filter: blur(4px); }
:host(.compact) .pill:empty { display: none; }
.pill .pd { width: 9px; height: 9px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px currentColor; color: var(--dim); }
.pill .pd.on { background: currentColor; }
.pill .sep { width: 1px; height: 12px; background: rgba(255,255,255,.15); }
`;
  var Panel = class {
    constructor(handlers) {
      this.handlers = handlers;
      this.host = document.createElement("bo1z-coop");
      this.root = this.host.attachShadow({ mode: "closed" });
      const mark = PLAYER_COLORS.map((c) => `<i style="background:${c}"></i>`).join("");
      this.root.innerHTML = `<style>${STYLE}</style><div class="card"><div class="head"><span class="mark">${mark}</span><span class="title"><b>Co-op</b><span class="tagline"></span></span><span class="chip"></span><button class="icon" data-act="collapse" title="Minimise">–</button></div><div class="body"></div></div><div class="pill"></div>`;
      this.body = this.root.querySelector(".body");
      this.chip = this.root.querySelector(".chip");
      this.tagline = this.root.querySelector(".tagline");
      this.pill = this.root.querySelector(".pill");
      this.collapseButton = this.root.querySelector('[data-act="collapse"]');
      this.view = null;
      for (const type of ["keydown", "keyup", "keypress", "click", "mousedown", "mouseup", "pointerdown", "pointerup", "wheel"]) {
        this.host.addEventListener(type, (event) => event.stopPropagation());
      }
      this.root.addEventListener("click", (event) => {
        const button = event.target.closest?.("[data-act]");
        if (!button || button.disabled) return;
        const act = button.dataset.act;
        if (act === "collapse") {
          const collapsed = this.host.classList.toggle("collapsed");
          this.collapseButton.textContent = collapsed ? "+" : "–";
          return;
        }
        const field = button.dataset.field ? this.root.querySelector(`input[data-field="${button.dataset.field}"]`) : null;
        this.handlers[act]?.(field ? field.value : void 0);
      });
      this.root.addEventListener("keydown", (event) => {
        const input = event.target.matches?.("input[data-act]") ? event.target : null;
        if (event.key === "Enter" && input) this.handlers[input.dataset.act]?.(input.value);
      });
    }
    mount() {
      const attach = () => {
        if (!this.host.isConnected) document.documentElement.append(this.host);
      };
      if (document.documentElement) attach();
      else document.addEventListener("readystatechange", attach, { once: true });
    }
    /** Re-renders only when the view changes, so typing in an input is never interrupted. */
    render(view2) {
      const key = JSON.stringify(view2);
      if (key === this.view) return;
      const focused = this.root.activeElement?.dataset?.field;
      const previous = new Map([...this.root.querySelectorAll("input[data-field]")].map((i) => [i.dataset.field, i.value]));
      this.view = key;
      this.chip.className = `chip ${view2.chip?.tone ?? ""}`;
      this.chip.textContent = view2.chip?.text ?? "";
      this.tagline.textContent = view2.tagline ?? "";
      this.host.classList.toggle("compact", Boolean(view2.compact));
      this.pill.replaceChildren(...this.pillParts(view2.pill));
      this.body.replaceChildren(...view2.blocks.map((block) => this.block(block)));
      for (const input of this.root.querySelectorAll("input[data-field]")) {
        if (previous.has(input.dataset.field)) input.value = previous.get(input.dataset.field);
        if (input.dataset.field === focused) input.focus();
      }
    }
    pillParts(pill) {
      if (!pill) return [];
      const parts = [];
      for (const p of pill.players ?? []) {
        const d = document.createElement("span");
        d.className = `pd ${p.on ? "on" : ""}`;
        d.style.color = PLAYER_COLORS[p.n - 1];
        parts.push(d);
      }
      for (const text of pill.texts ?? []) {
        if (parts.length) parts.push(Object.assign(document.createElement("span"), { className: "sep" }));
        parts.push(document.createTextNode(text));
      }
      return parts;
    }
    block(block) {
      const el = (tag, cls, text) => {
        const e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text != null) e.textContent = text;
        return e;
      };
      const button = (b) => {
        const e = el("button", `act ${b.style ?? ""}`, b.label);
        e.dataset.act = b.act;
        if (b.field) e.dataset.field = b.field;
        if (b.disabled) e.disabled = true;
        return e;
      };
      switch (block.kind) {
        case "text":
          return el("div", block.cls ?? "", block.text);
        case "label": {
          const box = el("div", "label", block.text);
          if (block.aside) box.append(el("em", "", block.aside));
          return box;
        }
        case "room": {
          const box = el("div", "panel");
          const label = el("div", "label", block.label);
          if (block.aside) label.append(el("em", "", block.aside));
          box.append(label, el("div", "code", block.code));
          if (block.buttons?.length) {
            const row = el("div", "row");
            for (const b of block.buttons) row.append(button(b));
            box.append(row);
          }
          return box;
        }
        case "map": {
          const box = el("div", "map");
          box.append(el("div", "glyph", block.glyph ?? "?"));
          const info = el("div");
          const name = el("div", "name", block.name);
          if (block.tag) name.append(el("span", "tag hell", block.tag));
          info.append(name, el("div", "sub", block.sub ?? ""));
          box.append(info);
          return box;
        }
        case "players": {
          const box = el("div");
          const label = el("div", "label", block.label);
          if (block.aside) label.append(el("em", "", block.aside));
          const list = el("div", "players");
          for (const p of block.players) {
            const row = el("div", `player ${p.empty ? "empty" : ""} ${p.me ? "me" : ""}`);
            const badge = el("div", "badge", String(p.n));
            badge.style.background = PLAYER_COLORS[p.n - 1];
            const who = el("div", "who");
            const name = el("div", "name", p.name);
            for (const t of p.tags ?? []) name.append(el("span", `tag ${t.cls}`, t.text));
            const st = el("div", "st");
            if (p.status) st.append(el("span", `dot ${p.tone ?? ""}`), document.createTextNode(p.status));
            who.append(name, st);
            row.append(badge, who);
            if (p.ping != null) {
              const ping = el("div", "ping");
              const bars = el("span", `bars q${p.ping < 80 ? 3 : p.ping < 180 ? 2 : 1}`);
              bars.append(el("i"), el("i"), el("i"));
              ping.append(bars, el("span", "", `${p.ping} ms`));
              row.append(ping);
            }
            list.append(row);
          }
          box.append(label, list);
          return box;
        }
        case "steps": {
          const box = el("div", "steps");
          block.steps.forEach((text, i) => {
            const state = i < block.current ? "done" : i === block.current ? `now ${block.fail ? "fail" : ""}` : "";
            const step = el("div", `step ${state}`);
            step.append(el("i"), el("span", "", text));
            box.append(step);
          });
          return box;
        }
        case "callout": {
          const box = el("div", `call ${block.tone ?? ""}`);
          const text = el("div");
          if (block.title) text.append(el("b", "", `${block.title} `));
          text.append(document.createTextNode(block.text ?? ""));
          box.append(text);
          if (block.buttons?.length) {
            const row = el("div", "row");
            for (const b of block.buttons) row.append(button(b));
            box.append(row);
          }
          return box;
        }
        case "buttons": {
          const row = el("div", "row");
          for (const b of block.buttons) row.append(button(b));
          return row;
        }
        case "input": {
          const box = el("div");
          if (block.label) box.append(el("div", "label", block.label));
          const row = el("div", "row");
          const input = el("input");
          input.placeholder = block.placeholder ?? "";
          input.spellcheck = false;
          if (block.maxLength) input.maxLength = block.maxLength;
          input.dataset.field = block.field;
          input.dataset.act = block.act;
          if (block.value) input.value = block.value;
          row.append(input, button({ act: block.act, label: block.button, field: block.field, style: `${block.style ?? ""} slim` }));
          box.append(row);
          return box;
        }
        case "kv": {
          const box = el("dl", "kv");
          for (const [k, v, cls] of block.items) box.append(el("dt", "", k), el("dd", cls ?? "", v));
          return box;
        }
        case "meter": {
          const box = el("div", "small muted");
          box.append(document.createTextNode(block.label));
          const bar = el("div", `meter ${block.fraction >= 1 ? "full" : block.fraction >= 0.75 ? "warn" : ""}`);
          const fill = el("span");
          fill.style.width = `${Math.round(Math.min(1, Math.max(0, block.fraction)) * 100)}%`;
          bar.append(fill);
          box.append(bar);
          return box;
        }
        case "section": {
          const box = el("div", `section ${block.open ? "" : "closed"}`);
          const toggle = el("button", "toggle", block.title);
          toggle.dataset.act = block.act;
          box.append(toggle);
          if (block.open) for (const child of block.blocks) box.append(this.block(child));
          return box;
        }
        case "credits":
          return el("div", "credits", block.text);
        default:
          return el("div");
      }
    }
  };

  // extension/src/gamepad.js
  var B = {
    cross: 0,
    circle: 1,
    square: 2,
    triangle: 3,
    l1: 4,
    r1: 5,
    l2: 6,
    r2: 7,
    create: 8,
    options: 9,
    l3: 10,
    r3: 11,
    up: 12,
    down: 13,
    left: 14,
    right: 15
  };
  var HOLD = /* @__PURE__ */ new Map([
    [B.cross, "gostand"],
    // jump
    [B.square, "usereload"],
    // reload; hold to use / buy / revive
    [B.l1, "smoke"],
    // special grenade (monkey bomb, ...)
    [B.r1, "frag"],
    // grenade
    [B.l2, "speed_throw"],
    // aim down sights
    [B.r2, "attack"],
    // fire
    [B.create, "scores"],
    [B.r3, "melee"]
  ]);
  var SLOTS = /* @__PURE__ */ new Map([[B.up, 1], [B.down, 2], [B.left, 3], [B.right, 4]]);
  var KEY = { escape: 27, enter: 13, up: 154, down: 155, left: 156, right: 157, mouse1: 200 };
  var MOVE = { forward: 301, back: 302, moveleft: 303, moveright: 304 };
  var STICK_DEADZONE = 0.16;
  var AIM_DEADZONE = 0.12;
  var TRIGGER = 0.35;
  var PRONE_HOLD_MS = 350;
  var AIM_SPEEDS = [400, 600, 800, 1e3, 1250, 1500, 1800, 2100, 2500, 3e3];
  var GamepadControl = class {
    /**
     * engine(): { Module, command(text) } or null while the game is not ready; canvasSize(): { width, height }.
     */
    constructor({ engine, canvasSize, aimLevel = 4 }) {
      this.engine = engine;
      this.canvasSize = canvasSize;
      this.aimLevel = aimLevel;
      this.pad = null;
      this.prev = [];
      this.held = /* @__PURE__ */ new Set();
      this.move = { forward: 0, back: 0, moveleft: 0, moveright: 0 };
      this.sprinting = false;
      this.circleAt = 0;
      this.proned = false;
      this.aimCarry = [0, 0];
      this.cursor = null;
      this.queue = [];
      this.lastTime = 0;
      this.status = "none";
      this.name = "";
      this.running = false;
    }
    start() {
      if (this.running) return;
      this.running = true;
      const frame = (time) => {
        if (!this.running) return;
        try {
          this.update(time);
        } catch (error) {
          this.status = `error: ${error.message}`;
        }
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      addEventListener("blur", () => this.releaseAll());
    }
    findPad() {
      const pads = navigator.getGamepads?.() ?? [];
      return [...pads].find((pad) => pad && pad.connected && pad.mapping === "standard") ?? [...pads].find((pad) => pad && pad.connected) ?? null;
    }
    update(time) {
      const dt = this.lastTime ? Math.min(0.1, (time - this.lastTime) / 1e3) : 0;
      this.lastTime = time;
      const pad = this.findPad();
      if (!pad) {
        if (this.pad) this.releaseAll();
        this.pad = null;
        this.status = "none";
        return;
      }
      this.pad = pad;
      this.name = pad.id;
      const engine = this.engine();
      if (!engine) {
        this.status = "waiting";
        return;
      }
      this.status = "active";
      const pressed = pad.buttons.map((b, i) => i === B.l2 || i === B.r2 ? b.value > TRIGGER : b.pressed);
      const edge = (i) => pressed[i] && !this.prev[i];
      const released = (i) => !pressed[i] && this.prev[i];
      const menu = Boolean(engine.Module._KB_UIState?.() & 1);
      if (menu) {
        this.releaseGameplay();
        this.menuInput(engine, pad, pressed, edge, released, dt);
      } else {
        this.cursor = null;
        this.gameplayInput(engine, pad, pressed, edge, released, dt);
      }
      this.prev = pressed;
      this.flush(engine);
    }
    gameplayInput(engine, pad, pressed, edge, released, dt) {
      for (const [button, action] of HOLD) {
        if (edge(button)) this.press(action);
        if (released(button)) this.lift(action);
      }
      for (const [button, slot] of SLOTS) {
        if (edge(button)) this.queue.push(`+actionslot ${slot}`);
        if (released(button)) this.queue.push(`-actionslot ${slot}`);
      }
      if (edge(B.triangle)) this.queue.push("weapnext");
      if (edge(B.options)) this.tapKey(engine, KEY.escape);
      if (edge(B.circle)) {
        this.circleAt = performance.now();
        this.proned = false;
      }
      if (pressed[B.circle] && !this.proned && performance.now() - this.circleAt > PRONE_HOLD_MS) {
        this.queue.push("toggleprone");
        this.proned = true;
      }
      if (released(B.circle) && !this.proned) this.queue.push("togglecrouch");
      const [lx, ly] = radial(pad.axes[0] ?? 0, pad.axes[1] ?? 0, STICK_DEADZONE);
      this.setMove("forward", Math.max(0, -ly));
      this.setMove("back", Math.max(0, ly));
      this.setMove("moveleft", Math.max(0, -lx));
      this.setMove("moveright", Math.max(0, lx));
      if (edge(B.l3) && !this.sprinting) {
        this.queue.push("+breath_sprint");
        this.sprinting = true;
      }
      if (this.sprinting && Math.hypot(lx, ly) < 0.3) {
        this.queue.push("-breath_sprint");
        this.sprinting = false;
      }
      const [rx, ry] = radial(pad.axes[2] ?? 0, pad.axes[3] ?? 0, AIM_DEADZONE);
      const magnitude = Math.hypot(rx, ry);
      if (magnitude > 0) {
        const speed = AIM_SPEEDS[this.aimLevel] * magnitude ** 1.6 / magnitude * (pressed[B.l2] ? 0.5 : 1);
        this.aimCarry[0] += rx * speed * dt;
        this.aimCarry[1] += ry * speed * dt;
        const dx = Math.trunc(this.aimCarry[0]), dy = Math.trunc(this.aimCarry[1]);
        this.aimCarry[0] -= dx;
        this.aimCarry[1] -= dy;
        if (dx || dy) engine.Module._KB_Input(2, dx, dy);
      }
    }
    menuInput(engine, pad, pressed, edge, released, dt) {
      const size = this.canvasSize();
      if (!this.cursor) this.cursor = [size.width / 2, size.height / 2];
      const [lx, ly] = radial(pad.axes[0] ?? 0, pad.axes[1] ?? 0, STICK_DEADZONE);
      const [rx, ry] = radial(pad.axes[2] ?? 0, pad.axes[3] ?? 0, AIM_DEADZONE);
      const vx = lx || rx, vy = ly || ry;
      if (vx || vy) {
        const speed = size.height * 1.1;
        this.cursor[0] = clamp(this.cursor[0] + vx * speed * dt, 0, size.width - 1);
        this.cursor[1] = clamp(this.cursor[1] + vy * speed * dt, 0, size.height - 1);
        engine.Module._KB_Input(4, Math.round(this.cursor[0]), Math.round(this.cursor[1]));
      }
      if (edge(B.cross)) engine.Module._KB_Input(0, KEY.mouse1, 1);
      if (released(B.cross)) engine.Module._KB_Input(0, KEY.mouse1, 0);
      if (edge(B.circle) || edge(B.options)) this.tapKey(engine, KEY.escape);
      for (const [button, key] of [[B.up, KEY.up], [B.down, KEY.down], [B.left, KEY.left], [B.right, KEY.right]]) {
        if (edge(button)) this.tapKey(engine, key);
      }
    }
    press(action) {
      if (!this.held.has(action)) {
        this.held.add(action);
        this.queue.push(`+${action}`);
      }
    }
    lift(action) {
      if (this.held.delete(action)) this.queue.push(`-${action}`);
    }
    tapKey(engine, key) {
      engine.Module._KB_Input(0, key, 1);
      engine.Module._KB_Input(0, key, 0);
    }
    setMove(action, value) {
      const previous = this.move[action];
      const rounded = Math.round(value * 20) / 20;
      if (rounded === previous) return;
      this.move[action] = rounded;
      if (rounded > 0) this.queue.push(`+${action} ${MOVE[action]} 0 ${rounded}`);
      else this.queue.push(`-${action} ${MOVE[action]}`);
    }
    releaseGameplay() {
      for (const action of [...this.held]) this.lift(action);
      for (const action of Object.keys(this.move)) this.setMove(action, 0);
      if (this.sprinting) {
        this.queue.push("-breath_sprint");
        this.sprinting = false;
      }
    }
    releaseAll() {
      this.releaseGameplay();
      this.prev = [];
      const engine = this.engine();
      if (engine) this.flush(engine);
    }
    /** One command string per frame through the mailbox; kept while the previous one is still pending. */
    flush(engine) {
      if (!this.queue.length) return;
      if (this.queue.length > 200) this.queue.splice(0, this.queue.length - 200);
      let count = 0, length = 0;
      while (count < this.queue.length && length + this.queue[count].length + 1 < 900) length += this.queue[count++].length + 1;
      if (engine.command(this.queue.slice(0, count).join(";"))) this.queue.splice(0, count);
    }
  };
  function radial(x, y, deadzone) {
    const magnitude = Math.hypot(x, y);
    if (magnitude < deadzone) return [0, 0];
    const scaled = Math.min(1, (magnitude - deadzone) / (1 - deadzone));
    return [x / magnitude * scaled, y / magnitude * scaled];
  }
  function clamp(value, low, high) {
    return Math.max(low, Math.min(high, value));
  }

  // extension/src/main.js
  var VERSION = "2.0.0";
  var DEFAULT_RELAY = "https://bo1z-coop-4p-relay.allanlotta.workers.dev";
  var BASE = "/bo1z/";
  var MAP_SLUGS = {
    zombie_pentagon: "five",
    zombie_theater: "kino",
    zombie_cod5_factory: "riese",
    zombie_cod5_prototype: "nacht",
    zombie_cod5_asylum: "verruckt",
    zombie_cod5_sumpf: "shinonuma",
    zombie_cosmodrome: "ascension",
    zombie_coast: "cotd",
    zombie_temple: "shangrila",
    zombie_moon: "moon"
  };
  var MAP_NAMES = {
    five: '"Five"',
    kino: "Kino der Toten",
    riese: "Der Riese",
    nacht: "Nacht der Untoten",
    verruckt: "Verr\xFCckt",
    shinonuma: "Shi No Numa",
    ascension: "Ascension",
    cotd: "Call of the Dead",
    shangrila: "Shangri-La",
    moon: "Moon"
  };
  var GAME_DVARS = /^(fs_mods|horde_[a-z_]+|kisak_mod_[a-z_]+|r_mod_[a-z_]+|r_dobjLimit|cg_mod_[a-z_]+|zinfo|noperks)$/i;
  var KICK_AFTER_MS = 15e3;
  var HOST_GONE_MS = 1e4;
  if (!window.__bo1zCoop) start();
  function start() {
    const params = new URLSearchParams(location.search);
    const requested = params.get("coop");
    const room = normalizeRoomCode(params.get("room") ?? "");
    const relayOverride = params.get("coopRelay");
    const coop = window.__bo1zCoop = {
      version: VERSION,
      mode: room && requested === "host" ? "host" : room && requested === "join" ? "guest" : null,
      room,
      relay: relayBase(relayOverride),
      relayParam: relayOverride && isLoopback(relayOverride) ? `&coopRelay=${encodeURIComponent(relayOverride)}` : "",
      // A host on its own relay puts it in the invite link; the guest switches to it with one click (a relay chosen
      // by someone else is never used silently).
      inviteRelay: normalizeRelay(params.get("relay") ?? ""),
      editRelay: false,
      uncapped: params.get("coopUncapped") !== "0",
      // Controller support needs the patched engine (its command mailbox), so with it on the engine is patched in
      // solo games too. Off: solo games run exactly as on vel.gg.
      controller: readSetting("bo1z-coop-controller", "1") !== "0",
      aimLevel: Math.max(0, Math.min(AIM_SPEEDS.length - 1, Number(readSetting("bo1z-coop-aim", "4")) || 0)),
      socket: "idle",
      peer: false,
      peerInfo: null,
      peerState: null,
      stats: null,
      hash: null,
      build: null,
      patched: false,
      error: null,
      notice: null,
      phase: "idle",
      mem: null,
      rings: null,
      zone: null,
      gameArgs: null,
      guestId: null,
      seat: null,
      // Host: one entry per guest seat ever seen this session.
      guests: /* @__PURE__ */ new Map(),
      joinSeat: null,
      // Lobby: the host's roster as guests last heard it; this player's name; the settings section.
      lobby: null,
      name: cleanName(readSetting("bo1z-coop-name", "")),
      showSettings: false,
      copiedAt: 0,
      refreshRate: 60,
      log: []
    };
    const note = (text) => {
      coop.log.push(`${(/* @__PURE__ */ new Date()).toISOString().slice(11, 23)} ${text}`);
      if (coop.log.length > 200) coop.log.shift();
    };
    coop.note = note;
    installWasmHook(coop);
    installCallMainHook(coop);
    measureRefreshRate(coop);
    const panel = new Panel({
      host: () => go(`${BASE}?coop=host&room=${createRoomCode()}${coop.relayParam}`),
      join: (text) => {
        const code = normalizeRoomCode(text);
        if (!code) {
          coop.notice = T.notRoomCode;
          return;
        }
        go(`${BASE}?coop=join&room=${code}${coop.relayParam}`);
      },
      copyCode: () => {
        navigator.clipboard?.writeText(coop.room).then(() => {
          coop.copiedCodeAt = Date.now();
        }, () => {
          coop.notice = coop.room;
        });
      },
      copy: () => {
        navigator.clipboard?.writeText(inviteLink(coop)).then(() => {
          coop.copiedAt = Date.now();
        }, () => {
          coop.notice = inviteLink(coop);
        });
      },
      leave: () => {
        coop.pump?.postMessage({ type: "close" });
        go(location.pathname);
      },
      startNow: () => {
        coop.startAlone = true;
      },
      rejoin: () => location.reload(),
      editRelay: () => {
        coop.editRelay = !coop.editRelay;
      },
      saveRelay: (text) => {
        const url = normalizeRelay(text ?? "");
        if (!url) {
          coop.notice = T.notRelay;
          return;
        }
        saveSetting("bo1z-coop-relay", url === DEFAULT_RELAY ? "" : url);
        location.reload();
      },
      defaultRelay: () => {
        saveSetting("bo1z-coop-relay", "");
        location.reload();
      },
      useInviteRelay: () => {
        saveSetting("bo1z-coop-relay", coop.inviteRelay);
        location.reload();
      },
      goToHost: () => {
        teleportToHost(coop, "button");
      },
      controller: () => {
        coop.controller = !coop.controller;
        saveSetting("bo1z-coop-controller", coop.controller ? "1" : "0");
        coop.notice = T.controllerReload;
      },
      settings: () => {
        coop.showSettings = !coop.showSettings;
      },
      saveName: (text) => {
        coop.name = cleanName(text);
        saveSetting("bo1z-coop-name", coop.name);
        coop.sentPhaseAt = 0;
      },
      aimDown: () => setAim(coop, coop.aimLevel - 1),
      aimUp: () => setAim(coop, coop.aimLevel + 1)
    });
    coop.panel = panel;
    panel.mount();
    if (coop.controller) {
      coop.gamepad = new GamepadControl({
        // Only while our player is in a game: the engine runs the commands and the menus own the cursor.
        engine: () => coop.mem && coop.patched && coop.mem.connectionState() === CONNECTION.active ? { Module: coop.mem.Module, command: (text) => coop.mem.command(text) } : null,
        canvasSize: () => {
          const canvas = document.getElementById("game");
          return { width: canvas?.width || 1280, height: canvas?.height || 720 };
        },
        aimLevel: coop.aimLevel
      });
      coop.gamepad.start();
    }
    const readUsage = () => fetch(`${coop.relay}/usage`).then((r) => r.ok ? r.json() : null).then((usage) => {
      coop.usage = usage && Number.isFinite(usage.fraction) ? usage : null;
    }, () => {
      coop.usage = null;
    });
    readUsage();
    setInterval(readUsage, 6e5);
    if (coop.mode === "guest") coop.guestId = guestIdFor(room);
    if (coop.mode) {
      coop.phase = coop.mode === "host" ? "hosting" : "joining-room";
      coop.pump = startPump(coop);
      if (coop.mode === "host") installStartWait(coop, panel);
    }
    setInterval(() => tick(coop), 50);
  }
  function installWasmHook(coop) {
    const nativeInstantiate = WebAssembly.instantiate;
    const nativeStreaming = WebAssembly.instantiateStreaming;
    const isEngine = (url) => /\/artifacts\/KisakBlack-web\.wasm(\?|$)/.test(url ?? "");
    async function prepare(bytes) {
      coop.hash = await sha256Hex(bytes);
      coop.build = BUILDS[coop.hash] ?? null;
      if (!coop.build) {
        coop.error = T.engineUpdated;
        coop.note(`unknown engine build ${coop.hash}`);
        return bytes;
      }
      try {
        const patched = patchEngine(bytes, coop.hash, coop.build, coop.mode);
        coop.patched = true;
        coop.note("engine patched");
        return patched;
      } catch (error) {
        coop.error = T.enginePatchFailed(error.message);
        coop.note(`patch failed: ${error.stack ?? error}`);
        return bytes;
      }
    }
    WebAssembly.instantiateStreaming = async function(source, imports) {
      if (!(coop.mode || coop.controller) || coop.hash) return nativeStreaming.call(WebAssembly, source, imports);
      const response = await source;
      if (!isEngine(response.url)) return nativeStreaming.call(WebAssembly, response, imports);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return nativeInstantiate.call(WebAssembly, await prepare(bytes), imports);
    };
    WebAssembly.instantiate = function(source, imports) {
      const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : ArrayBuffer.isView(source) ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength) : null;
      if ((coop.mode || coop.controller) && !coop.hash && bytes && bytes.byteLength > 5e6) {
        return prepare(bytes.slice()).then((ready) => nativeInstantiate.call(WebAssembly, ready, imports));
      }
      return nativeInstantiate.call(WebAssembly, source, imports);
    };
  }
  function installCallMainHook(coop) {
    Object.defineProperty(Object.prototype, "callMain", {
      configurable: true,
      enumerable: false,
      set(original) {
        delete Object.prototype.callMain;
        const Module = this;
        Object.defineProperty(Module, "callMain", {
          configurable: true,
          enumerable: true,
          writable: true,
          value(args) {
            if (!coop.mode && coop.patched) coop.mem = new EngineMemory(Module, coop.build);
            if (!coop.mode || !coop.patched) return original.call(this, args);
            return (async () => {
              try {
                if (coop.mode === "host") setupHost(coop, Module, args);
                else await setupGuest(coop, Module, args);
              } catch (error) {
                coop.error = error.message;
                coop.note(`setup failed: ${error.stack ?? error}`);
                coop.mem?.setInboundRing(0);
              }
              return original.call(this, args);
            })();
          }
        });
      }
    });
  }
  function installStartWait(coop, panel) {
    const block = (event) => {
      if (!coop.gate || event.composedPath?.().includes(panel.host)) return;
      event.stopImmediatePropagation();
      event.preventDefault();
    };
    for (const type of ["keydown", "keyup", "mousedown", "mouseup", "click", "pointerdown", "pointerup"]) {
      window.addEventListener(type, block, true);
    }
  }
  // extension/src/pump-worker.js
  // Runs in a Worker, built from this function's source: it may only use what it defines itself.
  function pumpWorker() {
    const PROTOCOL_VERSION = 3;
    const MAX_GUESTS = 3;
    const MAX_TEXT_BYTES = 4096;
    const MAX_BINARY_BYTES = 65536;
    const MAX_PACKET_BYTES = 1264;
    const BATCH_VERSION = 1;
    const BATCH_KIND_PACKETS = 1;
    const BATCH_KIND_SEAT_PACKETS = 2;
    function relaySocketUrl(relayBase, room, role, guestId) {
      const url = new URL(relayBase);
      url.protocol = url.protocol === "http:" || url.protocol === "ws:" ? "ws:" : "wss:";
      url.pathname = `/v1/rooms/${encodeURIComponent(room)}`;
      url.search = `?role=${role}&v=${PROTOCOL_VERSION}${role === "guest" ? `&id=${guestId}` : ""}`;
      return url.toString();
    }
    /** Guest batch: packets; host batch: { seat, packet } items. */
    function encodeBatch(items, seats) {
      const extra = seats ? 3 : 2;
      let size = 4;
      for (const item of items) size += extra + (seats ? item.packet : item).byteLength;
      if (items.length > 65535 || size > MAX_BINARY_BYTES) throw new RangeError("packet batch too large");
      const out = new Uint8Array(size);
      const view = new DataView(out.buffer);
      out[0] = BATCH_VERSION;
      out[1] = seats ? BATCH_KIND_SEAT_PACKETS : BATCH_KIND_PACKETS;
      view.setUint16(2, items.length, true);
      let offset = 4;
      for (const item of items) {
        const packet = seats ? item.packet : item;
        if (packet.byteLength > MAX_PACKET_BYTES) throw new RangeError("packet too large");
        if (seats) out[offset++] = item.seat;
        view.setUint16(offset, packet.byteLength, true);
        out.set(packet, offset + 2);
        offset += 2 + packet.byteLength;
      }
      return out;
    }
    /** Returns { seat, packet } items (seat 0 in a guest batch), or null for a malformed batch. */
    function decodeBatch(data, seats) {
      const bytes = new Uint8Array(data);
      if (bytes.byteLength < 4 || bytes[0] !== BATCH_VERSION || bytes[1] !== (seats ? BATCH_KIND_SEAT_PACKETS : BATCH_KIND_PACKETS)) return null;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = view.getUint16(2, true);
      const items = [];
      let offset = 4;
      for (let i = 0; i < count; i += 1) {
        let seat = 0;
        if (seats) {
          if (offset + 1 > bytes.byteLength) return null;
          seat = bytes[offset++];
          if (seat < 1 || seat > MAX_GUESTS) return null;
        }
        if (offset + 2 > bytes.byteLength) return null;
        const length = view.getUint16(offset, true);
        offset += 2;
        if (length > MAX_PACKET_BYTES || offset + length > bytes.byteLength) return null;
        items.push({ seat, packet: bytes.subarray(offset, offset + length) });
        offset += length;
      }
      return offset === bytes.byteLength ? items : null;
    }
    function parseControl(text) {
      if (typeof text !== "string" || text.length > MAX_TEXT_BYTES) return null;
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return null;
      }
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.t !== "string" || value.t.length > 32) return null;
      return value;
    }

    // extension/src/rings.js
    class RingReader {
      constructor(memory, layout, base, { advanceGet = false } = {}) {
        this.i32 = new Int32Array(memory);
        this.u8 = new Uint8Array(memory);
        this.lb = layout.loopback;
        this.base = base;
        this.getIndex = base + this.lb.offGet >> 2;
        this.sendIndex = base + this.lb.offSend >> 2;
        this.advanceGet = advanceGet;
        this.cursor = Atomics.load(this.i32, this.sendIndex);
        this.lost = 0;
      }
      /** Skip everything written so far. */
      skipToEnd() {
        this.cursor = Atomics.load(this.i32, this.sendIndex);
        if (this.advanceGet) Atomics.store(this.i32, this.getIndex, this.cursor);
      }
      /** Copies out every complete packet since the last poll. */
      poll(out = []) {
        const { slots, slotSize, offLen, dataMax } = this.lb;
        let send = Atomics.load(this.i32, this.sendIndex);
        if (send - this.cursor > slots - 1) {
          this.lost += send - (slots - 1) - this.cursor;
          this.cursor = send - (slots - 1);
        }
        while (this.cursor < send) {
          const slot = this.base + (this.cursor & slots - 1) * slotSize;
          const length = this.i32[slot + offLen >> 2];
          const packet = length > 0 && length <= dataMax ? this.u8.slice(slot, slot + length) : null;
          send = Atomics.load(this.i32, this.sendIndex);
          if (send - this.cursor > slots - 1) {
            this.lost += 1;
          } else if (packet) {
            out.push(packet);
          }
          this.cursor += 1;
        }
        if (this.advanceGet) Atomics.store(this.i32, this.getIndex, this.cursor);
        return out;
      }
    }
    class RingWriter {
      constructor(memory, layout, base) {
        this.i32 = new Int32Array(memory);
        this.u8 = new Uint8Array(memory);
        this.lb = layout.loopback;
        this.base = base;
        this.getIndex = base + this.lb.offGet >> 2;
        this.sendIndex = base + this.lb.offSend >> 2;
      }
      /** Room for one more packet without overwriting one the engine has not read yet. */
      hasRoom() {
        const send = Atomics.load(this.i32, this.sendIndex);
        const get = Atomics.load(this.i32, this.getIndex);
        return send - get < this.lb.slots - 1;
      }
      /** Writes a packet that the engine reads as coming from loopback `port`; false (nothing written) when full. */
      push(packet, port) {
        const { slots, slotSize, offLen, offPort, dataMax } = this.lb;
        if (packet.byteLength === 0 || packet.byteLength > dataMax) return true;
        if (!this.hasRoom()) return false;
        const send = Atomics.load(this.i32, this.sendIndex);
        const slot = this.base + (send & slots - 1) * slotSize;
        this.u8.set(packet, slot);
        Atomics.store(this.i32, slot + offLen >> 2, packet.byteLength);
        Atomics.store(this.i32, slot + offPort >> 2, port);
        Atomics.add(this.i32, this.sendIndex, 1);
        return true;
      }
    }
    function outOfBandCommand(packet) {
      if (packet.byteLength < 5 || packet[0] !== 255 || packet[1] !== 255 || packet[2] !== 255 || packet[3] !== 255) return null;
      let end = 4;
      while (end < packet.byteLength && end < 64 && packet[end] !== 0 && packet[end] !== 32 && packet[end] !== 10) end += 1;
      return String.fromCharCode(...packet.subarray(4, end));
    }

    const POLL_MS = 1;
    const FLUSH_MS = 4;
    const INBOX_LIMIT = 512;
    const PING_MS = 2e3;
    const state = {
      role: null,
      url: null,
      socket: null,
      closed: false,
      retries: 0,
      // Host: one reader per guest seat (the server's ring for that guest) and one writer (the shared inbound ring,
      // each packet stamped with its guest's port). Guest: reader 0 is the client's ring, the writer feeds port 0.
      readers: [],
      writer: null,
      ports: {},
      reading: false,
      injecting: false,
      dropUntilConnect: false,
      dropOutOfBand: [],
      inbox: [],
      outbox: [],
      lastFlush: 0,
      looping: false,
      stats: { packetsOut: 0, packetsIn: 0, bytesOut: 0, bytesIn: 0, framesOut: 0, framesIn: 0, dropped: 0, lost: 0, rtt: null, rtts: {} }
    };
    const hosting = () => state.role === "host";
    const post = (message) => self.postMessage(message);
    self.onmessage = (event) => {
      const message = event.data;
      switch (message.type) {
        case "connect":
          state.role = message.role;
          state.url = relaySocketUrl(message.relay, message.room, message.role, message.guestId);
          open();
          startLoop();
          return;
        case "attach":
          state.readers = message.reads.map(({ seat, base }) => ({ seat, ring: new RingReader(message.memory, message.layout, base, { advanceGet: message.advanceGet }) }));
          state.writer = new RingWriter(message.memory, message.layout, message.writeBase);
          state.ports = message.ports;
          state.reading = Boolean(message.reading);
          state.injecting = Boolean(message.injecting);
          state.dropOutOfBand = message.dropOutOfBand ?? [];
          return;
        case "read":
          for (const { ring } of state.readers) ring.skipToEnd();
          state.dropUntilConnect = Boolean(message.dropUntilConnect);
          state.reading = true;
          return;
        case "inject":
          state.injecting = Boolean(message.on);
          if (message.clearInbox) state.inbox.length = 0;
          return;
        case "send":
          sendText(message.message);
          return;
        case "close":
          state.closed = true;
          try {
            state.socket?.close(1e3, "bye");
          } catch {
          }
          return;
      }
    };
    function open() {
      if (state.closed) return;
      let socket;
      try {
        socket = new WebSocket(state.url);
      } catch (error) {
        post({ type: "socket", state: "error", reason: String(error?.message ?? error) });
        return reconnect();
      }
      socket.binaryType = "arraybuffer";
      state.socket = socket;
      post({ type: "socket", state: "connecting" });
      socket.onopen = () => {
        state.retries = 0;
        post({ type: "socket", state: "open" });
      };
      socket.onmessage = (event) => {
        if (typeof event.data === "string") {
          const message = parseControl(event.data);
          if (message) control(message);
          return;
        }
        const items = decodeBatch(event.data, hosting());
        if (!items) return;
        state.stats.framesIn += 1;
        for (const item of items) {
          state.stats.packetsIn += 1;
          state.stats.bytesIn += item.packet.byteLength;
          const command = outOfBandCommand(item.packet);
          if (command && state.dropOutOfBand.includes(command)) continue;
          state.inbox.push(item);
        }
        if (state.inbox.length > INBOX_LIMIT) {
          state.stats.dropped += state.inbox.length - INBOX_LIMIT;
          state.inbox.splice(0, state.inbox.length - INBOX_LIMIT);
        }
        pump();
      };
      socket.onclose = (event) => {
        if (state.socket === socket) state.socket = null;
        post({ type: "socket", state: "closed", code: event.code, reason: event.reason });
        // 4001: replaced by a newer connection; 4004: the room is full.
        if (event.code === 4001 || event.code === 4004) {
          state.closed = true;
          return;
        }
        reconnect();
      };
      socket.onerror = () => {
      };
    }
    function reconnect() {
      if (state.closed) return;
      const delay = Math.min(5e3, 250 * 2 ** state.retries);
      state.retries += 1;
      setTimeout(open, delay);
    }
    function control(message) {
      if (message.t === "ping") {
        sendText(hosting() ? { t: "pong", ts: message.ts, to: message.from } : { t: "pong", ts: message.ts });
        return;
      }
      if (message.t === "pong") {
        if (typeof message.ts === "number") {
          const rtt = Math.max(0, performance.now() - message.ts);
          if (hosting()) {
            // The host pings every guest at once: one ping per seat, and the slowest overall.
            if (Number.isInteger(message.from)) state.stats.rtts[message.from] = rtt;
            state.stats.rtt = Math.max(0, ...Object.values(state.stats.rtts));
          } else state.stats.rtt = rtt;
        }
        return;
      }
      post({ type: "control", message });
    }
    function sendText(message) {
      const socket = state.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(message));
      return true;
    }
    function flush(now) {
      if (!state.outbox.length) return;
      const socket = state.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        state.stats.dropped += state.outbox.length;
      } else {
        const seats = hosting();
        let batch = [], size = 4;
        const send = () => {
          if (!batch.length) return;
          socket.send(encodeBatch(batch, seats));
          state.stats.framesOut += 1;
          batch = [];
          size = 4;
        };
        for (const item of state.outbox) {
          const extra = (seats ? 3 : 2) + item.packet.byteLength;
          if (size + extra > MAX_BINARY_BYTES) send();
          batch.push(seats ? item : item.packet);
          size += extra;
          state.stats.packetsOut += 1;
          state.stats.bytesOut += item.packet.byteLength;
        }
        send();
      }
      state.outbox.length = 0;
      state.lastFlush = now;
    }
    function pump() {
      const now = performance.now();
      if (state.reading) {
        let lost = 0;
        for (const { seat, ring } of state.readers) {
          let packets = ring.poll([]);
          lost += ring.lost;
          if (state.dropUntilConnect && packets.length) {
            const first = packets.findIndex((packet) => outOfBandCommand(packet) === "connect");
            packets = first < 0 ? [] : packets.slice(first);
            if (first >= 0) state.dropUntilConnect = false;
          }
          for (const packet of packets) state.outbox.push({ seat, packet });
        }
        state.stats.lost = lost;
      }
      if (state.outbox.length && now - state.lastFlush >= FLUSH_MS) flush(now);
      if (state.writer && state.injecting) {
        while (state.inbox.length && state.writer.push(state.inbox[0].packet, state.ports[state.inbox[0].seat] ?? 0)) state.inbox.shift();
      }
    }
    async function startLoop() {
      if (state.looping) return;
      state.looping = true;
      const tick = new Int32Array(new SharedArrayBuffer(4));
      let lastPing = 0, lastStats = 0;
      while (!state.closed) {
        pump();
        const now = performance.now();
        if (now - lastPing >= PING_MS) {
          lastPing = now;
          sendText({ t: "ping", ts: now });
        }
        if (now - lastStats >= 1e3) {
          lastStats = now;
          post({ type: "stats", stats: { ...state.stats, inbox: state.inbox.length } });
        }
        const wait = Atomics.waitAsync ? Atomics.waitAsync(tick, 0, 0, POLL_MS) : null;
        if (wait?.async) await wait.value;
        else await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    }
  }
  function startPump(coop) {
    const url = URL.createObjectURL(new Blob([`(${pumpWorker.toString()})();\n`], { type: "text/javascript" }));
    const worker = new Worker(url, { name: "bo1z-coop-pump" });
    worker.onmessage = (event) => {
      const message = event.data;
      if (message.type === "socket") {
        coop.socket = message.state;
        if (message.state !== "open") {
          coop.peer = false;
          for (const guest of coop.guests.values()) {
            if (guest.present) guest.leftAt = Date.now();
            guest.present = false;
          }
        }
        if (message.state === "closed" && message.code === 4001) coop.error = T.replaced;
        if (message.state === "closed" && message.code === 4004) coop.error = T.full(MAX_GUESTS + 1);
        coop.note(`relay ${message.state}${message.code ? ` ${message.code}` : ""}`);
      } else if (message.type === "control") {
        onControl(coop, message.message);
      } else if (message.type === "stats") {
        coop.stats = message.stats;
      }
    };
    worker.onerror = (event) => {
      coop.error = T.workerFailed(event.message);
    };
    worker.postMessage({ type: "connect", relay: coop.relay, room: coop.room, role: coop.mode, guestId: coop.guestId });
    return worker;
  }
  function send(coop, message) {
    coop.pump?.postMessage({ type: "send", message });
  }
  function onControl(coop, message) {
    const host = coop.mode === "host";
    switch (message.t) {
      case "welcome":
        coop.peerSeenAt = Date.now();
        if (host) {
          for (const seat of Array.isArray(message.guests) ? message.guests : []) guestJoined(coop, seat);
          coop.peer = anyGuest(coop);
        } else {
          coop.seat = Number.isInteger(message.seat) ? message.seat : null;
          coop.peer = Boolean(message.peer);
          if (coop.peer) greet(coop);
        }
        return;
      case "peer":
        if (host) {
          if (!validSeat(message.seat)) return;
          if (message.present) guestJoined(coop, message.seat);
          else {
            const guest = guestRecord(coop, message.seat);
            guest.present = false;
            guest.leftAt = Date.now();
            guest.pause = false;
            coop.note(`player ${message.seat + 1} left the room`);
          }
          coop.peer = anyGuest(coop);
          return;
        }
        coop.peer = Boolean(message.present);
        if (coop.peer) {
          coop.peerSeenAt = Date.now();
          greet(coop);
        } else {
          coop.peerLeftAt = Date.now();
          coop.remotePause = false;
        }
        coop.note(`host ${coop.peer ? "joined the room" : "left the room"}`);
        return;
      case "error":
        coop.note(`relay error ${message.code}`);
        if (message.code === "room_full") coop.error = T.full(MAX_GUESTS + 1);
        return;
      case "info":
        if (!host) onHostInfo(coop, message);
        return;
      case "state":
        if (host) {
          if (validSeat(message.from)) guestRecord(coop, message.from).state = message;
        } else coop.peerState = message;
        return;
      case "pause":
        if (host) {
          if (validSeat(message.from)) guestRecord(coop, message.from).pause = Boolean(message.on);
        } else coop.remotePause = Boolean(message.on);
        return;
      case "lobby":
        if (!host && Array.isArray(message.players)) coop.lobby = message;
        return;
      case "pos":
        if (!host && Array.isArray(message.o) && message.o.length === 3 && message.o.every(Number.isFinite)) {
          coop.hostPos = { origin: message.o, at: Date.now() };
        }
        return;
    }
  }
  var validSeat = (seat) => Number.isInteger(seat) && seat >= 1 && seat <= MAX_GUESTS;
  function guestRecord(coop, seat) {
    let guest = coop.guests.get(seat);
    if (!guest) {
      guest = { seat, present: false, state: null, pause: false, slot: null, leftAt: 0, lastKickAt: 0, sentState: null, sentPause: null };
      coop.guests.set(seat, guest);
    }
    return guest;
  }
  function guestJoined(coop, seat) {
    if (!validSeat(seat)) return;
    const guest = guestRecord(coop, seat);
    if (!guest.present) coop.note(`player ${seat + 1} joined the room`);
    guest.present = true;
    guest.state = null;
    guest.pause = false;
    guest.sentState = null;
    guest.sentPause = null;
    coop.sentLobby = null;
    sendInfo(coop, seat);
  }
  var anyGuest = (coop) => [...coop.guests.values()].some((guest) => guest.present);
  function greet(coop) {
    if (coop.mode === "host") return;
    send(coop, { t: "state", phase: coop.phase, v: VERSION, name: coop.name });
    send(coop, { t: "pause", on: Boolean(coop.menuOpen) });
  }
  function sendInfo(coop, to) {
    const zone = coop.zone ?? currentZone();
    send(coop, {
      t: "info",
      v: VERSION,
      hash: coop.hash,
      zone,
      slug: MAP_SLUGS[zone] ?? null,
      horde: currentHorde(),
      gameArgs: coop.gameArgs,
      ...to ? { to } : {}
    });
  }
  function onHostInfo(coop, info) {
    coop.peerInfo = info;
    if (!info.slug || coop.mem) return;
    if (currentSlug() === info.slug && currentHorde() === Boolean(info.horde)) return;
    coop.phase = "following";
    go(`${BASE}${info.slug}?coop=join&room=${coop.room}${info.horde ? "&horde=1" : ""}${coop.relayParam}`);
  }
  // The host's own client; guests take 1000 + 10000 * (seat - 1) + 1..9999. The server tells clients apart by qport
  // (every loopback address looks the same to it), and refuses a connect whose qport an active client already uses.
  var HOST_QPORT = 7;
  function guestQport(seat) {
    return 1e3 + 1e4 * (seat - 1) + 1 + Math.floor(Math.random() * 9999);
  }
  function setupHost(coop, Module, args) {
    const mem = new EngineMemory(Module, coop.build);
    if (!mem.mailboxesClear()) throw new Error(T.unexpectedMemory);
    const rings = mem.allocateRemoteRings(MAX_GUESTS);
    mem.setInboundRing(rings.inPort);
    coop.mem = mem;
    coop.rings = rings;
    insertBeforeDevmap(args, ["+setqport", String(HOST_QPORT)]);
    if (coop.uncapped) insertBeforeDevmap(args, ["+set", "kisak_web_uncapped", "1", "+set", "com_maxfps", String(coop.refreshRate)]);
    coop.zone = devmapZone(args);
    coop.gameArgs = gameDvars(args);
    const ports = {};
    for (const [seat, ring] of Object.entries(rings.seats)) ports[seat] = ring.port;
    coop.pump.postMessage({
      type: "attach",
      memory: mem.memory,
      layout: coop.build,
      reads: Object.entries(rings.seats).map(([seat, ring]) => ({ seat: Number(seat), base: ring.out.base })),
      writeBase: rings.in.base,
      ports,
      advanceGet: true,
      reading: true,
      injecting: true,
      dropOutOfBand: ["rcon"]
    });
    coop.note(`host rings: out ${Object.values(ports).join(", ")} in ${rings.inPort}`);
    if (coop.peer) sendInfo(coop);
  }
  async function setupGuest(coop, Module, args) {
    const info = await until(() => coop.peerInfo?.zone ? coop.peerInfo : null, 3e4);
    if (!info) throw new Error(T.hostNoAnswer);
    if (info.hash && info.hash !== coop.hash) throw new Error(T.versionMismatch);
    const zone = devmapZone(args);
    if (zone !== info.zone) throw new Error(T.hostPlaying(MAP_NAMES[info.slug] ?? info.zone));
    if (Array.isArray(info.gameArgs)) applyGameDvars(args, info.gameArgs);
    const mem = new EngineMemory(Module, coop.build);
    if (!mem.mailboxesClear()) throw new Error(T.unexpectedMemory);
    coop.mem = mem;
    coop.zone = zone;
    coop.pump.postMessage({
      type: "attach",
      memory: mem.memory,
      layout: coop.build,
      // our client -> server ring: forwarded to the host once connected
      reads: [{ seat: 0, base: ringOffsets(coop.build, 1).base }],
      // server -> our client ring: the host's packets go here
      writeBase: ringOffsets(coop.build, 0).base,
      ports: { 0: 0 },
      advanceGet: true,
      reading: false,
      injecting: false
    });
    coop.phase = "loading";
  }
  function tick(coop) {
    try {
      if (coop.mode === "host") hostTick(coop);
      if (coop.mode === "guest") guestTick(coop);
    } catch (error) {
      coop.error = error.message;
      coop.note(`tick failed: ${error.stack ?? error}`);
    }
    coop.panel.render(view(coop));
  }
  var GUEST_CONNECTING = ["freezing", "connect", "challenging", "joining"];
  var JOIN_TURN_MS = 6e4;
  var STATE_REPEAT_MS = 2e3;
  function hostTick(coop) {
    const screen = window.five?.screen;
    const mem = coop.mem;
    const now = Date.now();
    const ready = Boolean(mem) && (screen === "ready" || screen === "playing");
    const clients = mem && coop.rings ? mem.serverClients() : [];
    for (let seat = 1; seat <= MAX_GUESTS; seat += 1) {
      const port = coop.rings?.seats[seat]?.port;
      const slot = port ? clients.find((c) => c.loopback && c.port === port) ?? null : null;
      if (slot || coop.guests.has(seat)) guestRecord(coop, seat).slot = slot;
    }
    const guests = [...coop.guests.values()];
    const present = guests.filter((g) => g.present);
    const active = (g) => g.slot?.state === CLIENT_STATE.active;
    const phase = (g) => g.state?.phase;

    // One guest connects at a time: the server matches connects by qport and port only, so two at once can collide.
    const turn = coop.joinSeat ? coop.guests.get(coop.joinSeat) : null;
    if (turn && (!turn.present || ["connected", "ended", "failed"].includes(phase(turn)) || now - coop.joinGrantedAt > JOIN_TURN_MS)) {
      coop.note(`player ${turn.seat + 1} join turn over (${turn.present ? phase(turn) : "left"})`);
      coop.joinSeat = null;
    }
    if (!coop.joinSeat && ready) {
      const next = present.find((g) => ["waiting-host", "connect"].includes(phase(g)));
      if (next) {
        coop.joinSeat = next.seat;
        coop.joinGrantedAt = now;
        coop.note(`player ${next.seat + 1} may join`);
      }
    }
    for (const g of present) {
      const state = { t: "state", to: g.seat, ready, slot: g.slot?.state ?? 0, screen, turn: coop.joinSeat === g.seat };
      const key = JSON.stringify(state);
      if (key !== g.sentState || now - (g.sentStateAt ?? 0) > STATE_REPEAT_MS) {
        g.sentState = key;
        g.sentStateAt = now;
        send(coop, state);
      }
    }

    const waiting = present.filter((g) => !active(g) && !["ended", "failed"].includes(phase(g)));
    coop.gate = screen === "ready" && !coop.startAlone && waiting.length > 0;
    const joining = present.some((g) => ["waiting-host", ...GUEST_CONNECTING].includes(phase(g)));
    if (mem && joining && screen === "ready" && !coop.introReleased && mem.int(coop.build.browser.introState) === 1) {
      coop.introReleased = true;
      mem.Module._KB_Input?.(7, 1, 0);
      coop.note("released the start hold so the other players can join");
    }
    const menuOpen = Boolean(mem?.menuOpen()) && screen === "playing";
    coop.menuOpen = menuOpen;
    const linked = present.filter((g) => active(g) && phase(g) === "connected");
    // Somebody connecting needs the server running; a pause waits until they are in.
    const connecting = present.some((g) => !active(g) && GUEST_CONNECTING.includes(phase(g)));
    if (mem) pauseHost(coop, linked.length > 0 && !connecting && (menuOpen || linked.some((g) => g.pause)), menuOpen);
    if (mem && !coop.pausedApplied && present.some((g) => !active(g))) {
      if (mem.dvarInt("clPaused")) mem.setDvarInt("clPaused", 0);
      if (mem.dvarInt("svPaused")) mem.setDvarInt("svPaused", 0);
    }
    // Each guest is paused by the host's menu or by any other guest's.
    for (const g of present) {
      const on = menuOpen || linked.some((other) => other !== g && other.pause);
      if (on !== g.sentPause) {
        g.sentPause = on;
        send(coop, { t: "pause", on, to: g.seat });
      }
    }
    broadcastLobby(coop);
    const view2 = latestView();
    if (present.some(active) && view2 && view2.ms !== coop.sentViewMs) {
      coop.sentViewMs = view2.ms;
      send(coop, { t: "pos", o: view2.origin, a: view2.angles });
    }
    for (const g of guests) {
      const slot = g.slot;
      const stale = slot && slot.state >= CLIENT_STATE.connected && (g.present && phase(g) && !["challenging", "joining", "connected"].includes(phase(g)) || !g.present && g.leftAt && now - g.leftAt > KICK_AFTER_MS);
      if (!stale) g.kicks = 0;
      // Few and spaced: a kick the server has not run yet must not hit whoever takes the slot next.
      if (stale && (g.kicks ?? 0) < 4 && now - g.lastKickAt > 15e3 && mem.command(`clientkick ${slot.slot}`)) {
        g.lastKickAt = now;
        g.kicks = (g.kicks ?? 0) + 1;
        coop.note(`removed player ${g.seat + 1} (slot ${slot.slot}, ${g.present ? phase(g) : "left"})`);
      }
    }
  }
  function pauseHost(coop, paused, menuOpen) {
    const mem = coop.mem;
    if (paused) {
      if (!coop.pausedApplied) coop.note(`paused${menuOpen ? "" : " by another player"}`);
      mem.setFreeze(true);
      if (!mem.dvarInt("svPaused")) mem.setDvarInt("svPaused", 1);
      if (!mem.dvarInt("clPaused")) mem.setDvarInt("clPaused", 1);
      mem.clearLastPacketTime();
    } else if (coop.pausedApplied) {
      mem.setFreeze(false);
      mem.setDvarInt("svPaused", 0);
      if (!menuOpen) mem.setDvarInt("clPaused", 0);
      mem.clearLastPacketTime();
      coop.note("resumed");
    }
    coop.pausedApplied = paused;
  }
  function latestView() {
    const view2 = window.five?.views?.at(-1);
    return view2 && Array.isArray(view2.origin) && view2.origin.length === 3 && view2.origin.every(Number.isFinite) ? view2 : null;
  }
  var distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  var SPAWN_JUMP = 400;
  var FAR_FROM_HOST = 300;
  var HOST_POS_MAX_AGE_MS = 6e3;
  var SPAWN_CHECK_MS = 2e3;
  var SPAWN_RETRIES = 2;
  function followHost(coop) {
    if (coop.peerState?.screen !== "playing") return;
    const view2 = latestView();
    if (view2 && view2.ms !== coop.lastViewMs) {
      const previous = coop.lastViewOrigin;
      coop.lastViewMs = view2.ms;
      coop.lastViewOrigin = view2.origin;
      if (!previous || distance(previous, view2.origin) > SPAWN_JUMP) spawnPending(coop);
    }
    const pending = coop.spawn;
    if (!pending || coop.pausedApplied) return;
    const host = coop.hostPos, mine = coop.lastViewOrigin;
    if (!host || Date.now() - host.at > HOST_POS_MAX_AGE_MS || !mine) return;
    if (pending.sentAt && Date.now() - pending.sentAt < SPAWN_CHECK_MS) return;
    if (distance(host.origin, mine) <= FAR_FROM_HOST) {
      coop.spawn = null;
      return;
    }
    if (pending.tries >= SPAWN_RETRIES) {
      coop.spawn = null;
      coop.note("could not move next to the host");
      return;
    }
    if (teleportToHost(coop, pending.tries ? "spawn, retry" : "spawn")) {
      pending.sentAt = Date.now();
      pending.tries += 1;
    }
  }
  function spawnPending(coop) {
    if (!coop.spawn) coop.spawn = { tries: 0, sentAt: 0 };
  }
  var EYE_HEIGHT = 62;
  function teleportToHost(coop, why) {
    const mem = coop.mem, host = coop.hostPos;
    if (!mem || coop.phase !== "connected" || !host) return false;
    if (Date.now() - (coop.teleportedAt ?? 0) < 1e3) return false;
    const target = [host.origin[0], host.origin[1], host.origin[2] + EYE_HEIGHT];
    const text = `setviewpos ${target.map((v) => v.toFixed(1)).join(" ")}`;
    if (!mem.command(text)) return false;
    coop.teleportedAt = Date.now();
    coop.note(`moved to the host (${why})`);
    return true;
  }
  function pauseGuest(coop, screen) {
    const mem = coop.mem;
    const menuOpen = mem.menuOpen() && screen === "playing";
    if (menuOpen !== coop.menuOpen) {
      coop.menuOpen = menuOpen;
      if (coop.peer) send(coop, { t: "pause", on: menuOpen });
    }
    const paused = menuOpen || coop.peer && Boolean(coop.remotePause);
    if (paused) {
      if (!coop.pausedApplied) coop.note(`paused${menuOpen ? "" : " by the host"}`);
      if (!mem.dvarInt("svPaused")) mem.setDvarInt("svPaused", 1);
      if (!mem.dvarInt("clPaused")) mem.setDvarInt("clPaused", 1);
      mem.clearLastPacketTime();
    } else {
      if (coop.pausedApplied) {
        mem.clearLastPacketTime();
        coop.note("resumed");
      }
      if (mem.dvarInt("svPaused")) mem.setDvarInt("svPaused", 0);
      if (mem.dvarInt("clPaused")) mem.setDvarInt("clPaused", 0);
    }
    coop.pausedApplied = paused;
  }
  var GUEST_JOINING = ["challenging", "joining"];
  function guestTick(coop) {
    const screen = window.five?.screen;
    if (screen === "error" && !["ended", "failed"].includes(coop.phase)) {
      coop.phase = "ended";
      coop.note("engine stopped");
    }
    if (coop.mem && ["freezing", "connect"].includes(coop.phase)) coop.mem.clearLastPacketTime();
    if (coop.mem && GUEST_JOINING.includes(coop.phase)) {
      if (coop.mem.dvarInt("clPaused")) coop.mem.setDvarInt("clPaused", 0);
      if (coop.mem.dvarInt("svPaused")) coop.mem.setDvarInt("svPaused", 0);
    }
    if (coop.peer && (coop.phase !== coop.sentPhase || Date.now() - (coop.sentPhaseAt ?? 0) > STATE_REPEAT_MS)) {
      coop.sentPhase = coop.phase;
      coop.sentPhaseAt = Date.now();
      send(coop, { t: "state", phase: coop.phase, v: VERSION, name: coop.name });
    }
    if (!coop.peer) coop.sentPhase = null;
    const mem = coop.mem;
    const conn = mem?.connectionState();
    const hostReady = coop.peer && coop.peerState?.ready;
    switch (coop.phase) {
      case "loading":
        if (screen === "ready" || screen === "playing") coop.phase = "waiting-host";
        break;
      case "waiting-host":
        // The host lets one player connect at a time. Freezing starts our client's server-timeout clock, so wait
        // for the turn first.
        if (hostReady && coop.peerState?.turn && validSeat(coop.seat)) {
          mem.setFreeze(true);
          coop.freezeAt = Date.now();
          coop.phase = "freezing";
          coop.note("freezing local server");
        }
        break;
      case "freezing":
        if (!mem.serverDrainsPackets() || Date.now() - coop.freezeAt > 5e3) {
          if (mem.serverDrainsPackets()) coop.note("local server still drains packets after 5 s; continuing");
          mem.setDvarInt("svPaused", 0);
          coop.pump.postMessage({ type: "read", dropUntilConnect: true });
          coop.pump.postMessage({ type: "inject", on: false, clearInbox: true });
          coop.phase = "connect";
        }
        break;
      case "connect":
        if (!coop.introReleased && mem.int(coop.build.browser.introState) === 1) {
          coop.introReleased = true;
          mem.Module._KB_Input?.(7, 1, 0);
        }
        coop.connectWaitAt ??= Date.now();
        if ((coop.peerState?.slot ?? 0) >= CLIENT_STATE.connected && Date.now() - coop.connectWaitAt < 2e4) break;
        coop.qport ??= guestQport(coop.seat);
        if (mem.command(`setqport ${coop.qport};connect LOCALHOST`)) {
          coop.joinedLate = coop.peerState?.screen === "playing";
          coop.connectAt = Date.now();
          coop.phase = "challenging";
          coop.note("connect sent");
        }
        break;
      case "challenging":
        if (conn >= CONNECTION.connecting && conn <= CONNECTION.challenging && mem.setServerAddressPort(0) && mem.serverAddressPort() === 0) {
          coop.pump.postMessage({ type: "inject", on: true });
          coop.phase = "joining";
          coop.note("challenging; injecting host packets");
        } else if (Date.now() - coop.connectAt > 15e3) {
          coop.error = T.connectFailed;
          coop.phase = "failed";
        }
        break;
      case "joining":
        if (mem.serverAddressPort() !== 0) mem.setServerAddressPort(0);
        if (conn === CONNECTION.active) {
          coop.phase = "connected";
          coop.lastViewOrigin = null;
          spawnPending(coop);
          coop.note("connected to host");
        } else if (Date.now() - coop.connectAt > 9e4) {
          coop.error = T.notLetIn;
          coop.phase = "failed";
        }
        break;
      case "connected":
        if (conn < CONNECTION.challenging) {
          coop.phase = "ended";
          coop.note("disconnected");
        } else if (!coop.peer && coop.peerLeftAt && Date.now() - coop.peerLeftAt > HOST_GONE_MS) {
          coop.phase = "ended";
          coop.notice = T.hostLeft;
          mem.command("disconnect");
        } else {
          pauseGuest(coop, screen);
          // In the lobby the host may wait minutes for the others; a slow moment here must not time us out (the
          // engine skips its timeout while lastPacketTime is 0). The relay still tells us if the host leaves.
          if (coop.peerState?.screen !== "playing") mem.clearLastPacketTime();
          followHost(coop);
        }
        break;
      default:
    }
  }
  // extension/src/lobby.js
  /** Lobby names: letters, digits and a few marks, at most 16 characters. */
  function cleanName(text) {
    return String(text ?? "").replace(/[^\p{L}\p{N} _.\-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 16);
  }
  var roundPing = (rtt) => Number.isFinite(rtt) ? Math.round(rtt) : null;
  /** Host: what every player sees in the lobby (players 1..4, the host first). */
  function hostRoster(coop) {
    const screen = window.five?.screen;
    const playing = screen === "playing";
    const hostStatus = playing ? ["ingame", "ok"] : screen === "ready" ? ["lobby", "ok"] : screen === "loading" || screen === "download" || coop.mem ? ["loading", "wait"] : ["picking", "wait"];
    const players = [{ n: 1, name: coop.name, host: true, status: hostStatus[0], tone: hostStatus[1], ping: null }];
    const rtts = coop.stats?.rtts ?? {};
    for (let seat = 1; seat <= MAX_GUESTS; seat += 1) {
      const g = coop.guests.get(seat);
      const phase = g?.state?.phase;
      const active = g?.slot?.state === CLIENT_STATE.active;
      let status, tone;
      if (!g || !g.present && !g.slot && (!g.leftAt || Date.now() - g.leftAt > 6e4)) [status, tone] = ["free", ""];
      else if (!g.present) [status, tone] = g.slot ? ["reconnecting", "wait"] : ["left", "bad"];
      else if (["ended", "failed"].includes(phase)) [status, tone] = ["disconnected", "bad"];
      else if (active) [status, tone] = playing ? ["ingame", "ok"] : ["ready", "ok"];
      else if (coop.joinSeat === seat || g.slot || GUEST_CONNECTING.includes(phase)) [status, tone] = ["joining", "wait"];
      else if (phase === "waiting-host" && coop.mem) [status, tone] = ["turn", "wait"];
      else if (phase === "joining-room" && !coop.mem) [status, tone] = ["opening", "wait"];
      else [status, tone] = ["loading", "wait"];
      players.push({
        n: seat + 1,
        name: status === "free" ? "" : cleanName(g?.state?.name),
        status,
        tone,
        ping: g?.present ? roundPing(rtts[seat]) : null
      });
    }
    return { t: "lobby", players, slug: MAP_SLUGS[coop.zone ?? currentZone()] ?? null, horde: currentHorde(), playing };
  }
  function broadcastLobby(coop) {
    if (!coop.peer) {
      coop.sentLobby = null;
      return;
    }
    const lobby = hostRoster(coop);
    const key = JSON.stringify(lobby);
    if (key !== coop.sentLobby || Date.now() - (coop.sentLobbyAt ?? 0) > 5e3) {
      coop.sentLobby = key;
      coop.sentLobbyAt = Date.now();
      send(coop, lobby);
    }
  }
  /** A guest's copy of the host's lobby, with its own row filled in from what it knows best. */
  function guestRoster(coop) {
    const players = Array.isArray(coop.lobby?.players) ? coop.lobby.players.slice(0, MAX_GUESTS + 1) : [];
    if (!players.length) {
      players.push({ n: 1, name: "", host: true, status: coop.peer ? "loading" : "unknown", tone: coop.peer ? "wait" : "" });
      for (let seat = 1; seat <= MAX_GUESTS; seat += 1) players.push({ n: seat + 1, name: "", status: "free", tone: "" });
    }
    const mine = ownStatus(coop);
    return players.map((p) => validSeat(coop.seat) && p.n === coop.seat + 1 ? { ...p, name: coop.name, ping: roundPing(coop.stats?.rtt), status: mine[0], tone: mine[1] } : p);
  }
  function ownStatus(coop) {
    const phase = coop.phase;
    if (phase === "connected") return coop.lobby?.playing || coop.peerState?.screen === "playing" ? ["ingame", "ok"] : ["ready", "ok"];
    if (["ended", "failed"].includes(phase)) return ["disconnected", "bad"];
    if (GUEST_CONNECTING.includes(phase)) return ["joining", "wait"];
    if (phase === "waiting-host" && coop.peerState?.ready && !coop.peerState.turn) return ["turn", "wait"];
    return ["loading", "wait"];
  }
  function playerRows(coop, roster, meN) {
    return roster.map((p) => {
      const n = Number(p.n);
      const tags = [];
      if (p.host) tags.push({ cls: "host", text: T.hostTag });
      if (n === meN) tags.push({ cls: "you", text: T.you });
      const empty = p.status === "free";
      return {
        n,
        name: empty ? T.st.free : cleanName(p.name) || T.player(n),
        tags,
        me: n === meN,
        empty,
        status: empty ? "" : T.st[p.status] ?? T.st.unknown,
        tone: p.tone ?? "",
        ping: empty || p.host || !Number.isFinite(p.ping) ? null : p.ping
      };
    }).map((row) => row.empty ? { ...row, status: coop.mode === "host" ? T.freeHint : "" } : row);
  }
  function mapBlock(coop, slug, horde, sub) {
    return slug
      ? { kind: "map", glyph: MAP_GLYPHS[slug] ?? "?", name: MAP_NAMES[slug]?.replace(/"/g, "") ?? slug, tag: horde ? T.hell : null, sub }
      : { kind: "map", glyph: "?", name: T.noMap, sub };
  }

  function view(coop) {
    const blocks = [];
    const screen = window.five?.screen;
    const playing = screen === "playing" && !coop.mem?.menuOpen();
    const relayState = T.relayState[coop.socket] ?? T.relayState.idle;
    if (coop.error) blocks.push({ kind: "callout", tone: "bad", text: coop.error });
    if (coop.notice) blocks.push({ kind: "callout", tone: "info", text: coop.notice });
    if (!coop.mode) {
      blocks.push({ kind: "text", cls: "muted", text: T.intro });
      blocks.push({ kind: "buttons", buttons: [{ act: "host", label: T.host, style: "primary" }] });
      blocks.push({ kind: "input", label: T.joinLabel, field: "join", placeholder: T.joinPlaceholder, act: "join", button: T.join });
      blocks.push(settingsSection(coop, false));
      const pill = coop.gamepad?.status === "active" ? { texts: ["\u{1F3AE}"] } : null;
      return { chip: { text: T.chip.solo }, tagline: T.tagline, blocks, compact: playing && !coop.error && !coop.notice, pill };
    }
    const host = coop.mode === "host";
    const roster = host ? hostRoster(coop).players : guestRoster(coop);
    const meN = host ? 1 : validSeat(coop.seat) ? coop.seat + 1 : 0;
    const rows = playerRows(coop, roster, meN);
    const inGame = roster.filter((p) => p.status === "ingame" || p.status === "ready" || p.status === "lobby").length;
    const freeSeats = roster.filter((p) => p.status === "free").length;
    let chip;

    if (host) {
      const waiting = roster.some((p) => !p.host && ["joining", "turn", "loading", "opening", "reconnecting"].includes(p.status));
      const step = screen === "playing" ? 3 : screen === "ready" ? 2 : coop.mem || screen === "loading" || screen === "download" ? 1 : 0;
      chip = coop.error ? { text: T.chip.error, tone: "bad" } : coop.pausedApplied ? { text: T.chip.paused, tone: "wait" } : screen === "playing" ? { text: T.chip.ingame, tone: "ok live" } : { text: T.chip.hosting, tone: "wait live" };
      const linkCopied = Date.now() - coop.copiedAt < 2e3, codeCopied = Date.now() - (coop.copiedCodeAt ?? 0) < 2e3;
      blocks.push({ kind: "room", label: T.room, aside: T.inviteAside(freeSeats), code: coop.room, buttons: [
        { act: "copy", label: linkCopied ? T.copied : T.copy, style: linkCopied ? "done" : "primary" },
        { act: "copyCode", label: codeCopied ? T.copied : T.copyCode, style: codeCopied ? "done" : "" }
      ] });
      blocks.push({ kind: "steps", steps: T.stepsHost, current: step });
      if (!coop.mem && screen !== "loading" && screen !== "download") blocks.push({ kind: "callout", tone: "info", text: T.pickMap });
      else if (coop.gate) blocks.push({ kind: "callout", tone: "wait", text: T.gate, buttons: [{ act: "startNow", label: T.startNow }] });
      else if (screen === "ready" && !waiting && roster.length > 1 && roster.some((p) => !p.host && p.status === "ready")) blocks.push({ kind: "callout", tone: "ok", text: T.allIn });
      else if (waiting && screen === "playing") blocks.push({ kind: "callout", tone: "info", text: T.latecomers });
      if (coop.pausedApplied) blocks.push({ kind: "callout", tone: "wait", text: coop.menuOpen ? T.pausedYou : T.pausedBy });
      blocks.push(mapBlock(coop, MAP_SLUGS[coop.zone ?? currentZone()] ?? null, currentHorde(), T.mapSubHost));
    } else {
      const slug = coop.lobby?.slug ?? coop.peerInfo?.slug ?? null;
      const hostMap = slug ? MAP_NAMES[slug]?.replace(/"/g, "") : null;
      const phase = coop.phase;
      const step = { "joining-room": coop.peerInfo?.slug ? 1 : 0, following: 1, loading: 2, "waiting-host": 3, freezing: 3, connect: 3, challenging: 3, joining: 3, connected: 4 }[phase] ?? coop.lastStep ?? 0;
      if (!["ended", "failed"].includes(phase)) coop.lastStep = step;
      const failed = ["ended", "failed"].includes(phase);
      chip = coop.error ? { text: T.chip.error, tone: "bad" } : failed ? { text: T.chip.ended, tone: "bad" } : coop.pausedApplied ? { text: T.chip.paused, tone: "wait" } : phase === "connected" ? screen === "playing" ? { text: T.chip.ingame, tone: "ok live" } : { text: T.chip.lobby, tone: "ok" } : { text: T.chip.joining, tone: "wait live" };
      if (coop.inviteRelay && coop.inviteRelay !== coop.relay) {
        blocks.push({ kind: "callout", tone: "wait", text: T.otherRelay(new URL(coop.inviteRelay).hostname), buttons: [{ act: "useInviteRelay", label: T.useRelay, style: "primary" }] });
      }
      blocks.push({ kind: "steps", steps: T.stepsGuest, current: step, fail: failed });
      const onHostMap = coop.peerInfo?.slug && currentSlug() === coop.peerInfo.slug;
      const message = {
        "joining-room": coop.peer ? hostMap ? T.opening(hostMap) : T.hostPicking : T.waitingHost,
        following: T.opening(hostMap ?? "…"),
        loading: T.loadingMap,
        "waiting-host": coop.peerState?.ready && !coop.peerState.turn ? T.nextInLine : coop.peer ? T.hostLoading : T.waitingHost,
        freezing: T.connecting,
        connect: T.connecting,
        challenging: T.connecting,
        joining: T.joiningGame,
        connected: screen === "playing" ? null : coop.peerState?.screen === "playing" ? T.clickToPlay : screen === "ready" && coop.lobby?.playing ? T.clickToPlay : T.waitingStart,
        ended: T.ended,
        failed: T.failed
      }[phase];
      if ((phase === "loading" || phase === "joining-room" && onHostMap) && screen === "landing") blocks.push({ kind: "callout", tone: "wait", title: "⌨", text: T.pressKey });
      else if (message) blocks.push({ kind: "callout", tone: failed ? "bad" : phase === "connected" ? "ok" : "info", text: message, buttons: failed ? [{ act: "rejoin", label: T.rejoin, style: "primary" }] : [] });
      if (coop.joinedLate && ["joining", "connected"].includes(phase)) blocks.push({ kind: "callout", tone: "info", text: T.lateJoin });
      if (phase === "connected" && coop.pausedApplied) blocks.push({ kind: "callout", tone: "wait", text: coop.menuOpen ? T.pausedYou : T.pausedBy });
      blocks.push(mapBlock(coop, slug, coop.lobby?.horde ?? coop.peerInfo?.horde, T.mapSubGuest));
    }

    blocks.push({ kind: "players", label: T.players, aside: T.playersAside(inGame, MAX_GUESTS + 1), players: rows });
    const actions = [];
    if (!host && coop.phase === "connected" && coop.hostPos) actions.push({ act: "goToHost", label: T.goToHost });
    actions.push({ act: "leave", label: T.leave, style: "ghost" });
    blocks.push({ kind: "buttons", buttons: actions });
    blocks.push(settingsSection(coop, true));

    const ping = coop.stats?.rtt != null ? `${Math.round(coop.stats.rtt)} ms` : "–";
    const pill = {
      players: roster.map((p) => ({ n: p.n, on: ["ingame", "ready", "lobby"].includes(p.status) })),
      texts: [coop.pausedApplied ? T.chip.paused : ping, ...coop.gamepad?.status === "active" ? ["\u{1F3AE}"] : []]
    };
    return { chip, tagline: `${T.room} ${coop.room}`, blocks, compact: playing && !coop.error, pill };
  }
  function settingsSection(coop, inGame) {
    const blocks = [];
    blocks.push({ kind: "input", label: T.yourName, field: "name", placeholder: T.namePlaceholder, act: "saveName", button: T.save, value: coop.name, maxLength: 16 });
    if (inGame) {
      const items = [[T.relay, T.relayState[coop.socket] ?? T.relayState.idle, coop.socket === "open" ? "" : "error"], [T.ping, coop.stats?.rtt != null ? `${Math.round(coop.stats.rtt)} ms` : "–"]];
      if (coop.stats?.lost) items.push([T.dropped, String(coop.stats.lost)]);
      blocks.push({ kind: "kv", items });
    }
    blocks.push(...controllerBlocks(coop));
    blocks.push(...relayBlocks(coop));
    blocks.push({ kind: "credits", text: T.credits });
    return { kind: "section", title: T.settings, act: "settings", open: Boolean(coop.showSettings), blocks };
  }
  function controllerBlocks(coop) {
    const pad = coop.gamepad;
    const name = pad?.name ? pad.name.replace(/\s*\(.*$/, "").slice(0, 32) : "";
    const status = !coop.controller ? T.ctrl.off : !coop.patched && coop.hash ? T.ctrl.unavailable : !pad || pad.status === "none" ? T.ctrl.press : pad.status === "active" ? T.ctrl.active(name, coop.aimLevel + 1, AIM_SPEEDS.length) : T.ctrl.later(name);
    const buttons = coop.controller && pad?.status !== "none" ? [{ act: "aimDown", label: T.aimDown }, { act: "aimUp", label: T.aimUp }, { act: "controller", label: T.turnOff, style: "ghost" }] : [{ act: "controller", label: coop.controller ? T.turnOff : T.turnOn, style: "ghost" }];
    return [{ kind: "kv", items: [[T.controller, status]] }, { kind: "buttons", buttons }];
  }
  function relayBlocks(coop) {
    const own = coop.relay !== DEFAULT_RELAY;
    const blocks = [{ kind: "kv", items: [[T.relay, own ? T.relayCustom(new URL(coop.relay).hostname) : T.relayDefault]] }];
    if (!own) blocks.push({ kind: "text", cls: "muted small", text: T.relayNote });
    const usage = usageBlock(coop);
    if (usage) blocks.push(usage);
    if (coop.editRelay) {
      blocks.push({ kind: "input", field: "relay", placeholder: T.relayPlaceholder, act: "saveRelay", button: T.save, value: own ? coop.relay : "" });
      blocks.push({ kind: "text", cls: "muted small", text: T.relayEditNote });
      blocks.push({ kind: "buttons", buttons: [{ act: "defaultRelay", label: T.useDefault }, { act: "editRelay", label: T.cancel, style: "ghost" }] });
    } else {
      blocks.push({ kind: "buttons", buttons: [{ act: "editRelay", label: T.changeRelay, style: "ghost" }] });
    }
    return blocks;
  }
  function usageBlock(coop) {
    const usage = coop.usage;
    if (!usage) return null;
    const resets = new Date(usage.resetsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const label = usage.fraction >= 1 ? T.usedUp(resets) : T.usage(Math.round(usage.fraction * 100), resets);
    return { kind: "meter", fraction: usage.fraction, label };
  }
  function setAim(coop, level) {
    coop.aimLevel = Math.max(0, Math.min(AIM_SPEEDS.length - 1, level));
    if (coop.gamepad) coop.gamepad.aimLevel = coop.aimLevel;
    saveSetting("bo1z-coop-aim", String(coop.aimLevel));
  }
  function readSetting(key, fallback) {
    try {
      return localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }
  function saveSetting(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
    }
  }
  /** Random per guest and room, kept for the tab's life: a reload gets the same seat (and engine port) back. */
  function guestIdFor(room) {
    const key = `bo1z-coop-guest:${room}`;
    try {
      const saved = sessionStorage.getItem(key);
      if (saved && /^[a-z0-9]{8,32}$/.test(saved)) return saved;
      const id = createGuestId();
      sessionStorage.setItem(key, id);
      return id;
    } catch {
      return createGuestId();
    }
  }
  function go(url) {
    location.assign(url);
  }
  function inviteLink(coop) {
    const relay = coop.relay !== DEFAULT_RELAY && !coop.relayParam ? `&relay=${encodeURIComponent(coop.relay)}` : "";
    return `${location.origin}${BASE}?coop=join&room=${coop.room}${coop.relayParam}${relay}`;
  }
  function normalizeRelay(text) {
    try {
      const url = new URL(text.trim());
      if (url.protocol === "wss:") url.protocol = "https:";
      return url.protocol === "https:" && url.hostname.includes(".") ? url.origin : "";
    } catch {
      return "";
    }
  }
  function isLoopback(url) {
    try {
      return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
    } catch {
      return false;
    }
  }
  function relayBase(override) {
    if (override && isLoopback(override)) return override;
    try {
      const saved = localStorage.getItem("bo1z-coop-relay");
      const url = saved ? normalizeRelay(saved) : "";
      if (url) return url;
    } catch {
    }
    return DEFAULT_RELAY;
  }
  function currentZone() {
    const zone = document.documentElement?.dataset.map;
    if (zone) return zone;
    const slug = currentSlug();
    return Object.keys(MAP_SLUGS).find((z) => MAP_SLUGS[z] === slug) ?? null;
  }
  function currentSlug() {
    const zone = document.documentElement?.dataset.map;
    if (zone && MAP_SLUGS[zone]) return MAP_SLUGS[zone];
    const match = location.pathname.match(/^\/(?:bo1z\/)?([a-z]+)\/?$/);
    return match && Object.values(MAP_SLUGS).includes(match[1]) ? match[1] : null;
  }
  function currentHorde() {
    return document.documentElement?.dataset.mode === "horde" || new URLSearchParams(location.search).get("horde") === "1";
  }
  function devmapZone(args) {
    const i = args.indexOf("+devmap");
    return i >= 0 ? args[i + 1] : null;
  }
  function insertBeforeDevmap(args, extra) {
    const i = args.indexOf("+devmap");
    args.splice(i < 0 ? args.length : i, 0, ...extra);
  }
  function gameDvars(args) {
    const out = [];
    for (let i = 0; i + 2 < args.length; i += 1) if (args[i] === "+set" && GAME_DVARS.test(args[i + 1])) out.push([args[i + 1], args[i + 2]]);
    return out;
  }
  function applyGameDvars(args, dvars) {
    for (let i = args.length - 3; i >= 0; i -= 1) if (args[i] === "+set" && GAME_DVARS.test(args[i + 1])) args.splice(i, 3);
    const safe = dvars.filter(([k, v]) => typeof k === "string" && GAME_DVARS.test(k) && typeof v === "string" && /^[\w .-]{0,64}$/.test(v));
    insertBeforeDevmap(args, safe.flatMap(([k, v]) => ["+set", k, v]));
  }
  function until(fn, timeoutMs) {
    return new Promise((resolve) => {
      const startedAt = Date.now();
      const check = () => {
        const value = fn();
        if (value || Date.now() - startedAt > timeoutMs) resolve(value ?? null);
        else setTimeout(check, 100);
      };
      check();
    });
  }
  function measureRefreshRate(coop) {
    const times = [];
    const step = (t) => {
      times.push(t);
      if (times.length < 30) {
        requestAnimationFrame(step);
        return;
      }
      const deltas = times.slice(1).map((v, i) => v - times[i]).sort((a, b) => a - b);
      const median = deltas[deltas.length >> 1];
      if (median > 0) coop.refreshRate = Math.max(30, Math.min(240, Math.round(1e3 / median)));
    };
    requestAnimationFrame(step);
  }
})();
