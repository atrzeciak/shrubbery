import { b64urlDecode, b64urlEncode } from "../../src/util.js";

export function concat(...arrays) {
  const u8 = arrays.map((a) => (a instanceof Uint8Array ? a : new Uint8Array(a)));
  const out = new Uint8Array(u8.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of u8) { out.set(a, o); o += a.length; }
  return out;
}

export function cborEncode(value) {
  const parts = [];
  const head = (mt, n) => {
    if (n < 24) parts.push(new Uint8Array([(mt << 5) | n]));
    else if (n < 256) parts.push(new Uint8Array([(mt << 5) | 24, n]));
    else if (n < 65536) parts.push(new Uint8Array([(mt << 5) | 25, n >> 8, n & 0xff]));
    else parts.push(new Uint8Array([(mt << 5) | 26, (n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]));
  };
  const enc = (x) => {
    if (typeof x === "number") { if (x >= 0) head(0, x); else head(1, -1 - x); }
    else if (x instanceof Uint8Array) { head(2, x.length); parts.push(x); }
    else if (typeof x === "string") { const b = new TextEncoder().encode(x); head(3, b.length); parts.push(b); }
    else if (Array.isArray(x)) { head(4, x.length); x.forEach(enc); }
    else if (x instanceof Map) { head(5, x.size); for (const [k, v] of x) { enc(k); enc(v); } }
    else throw new Error("cborEncode: unsupported " + typeof x);
  };
  enc(value);
  return concat(...parts);
}

function derInt(bytes) {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  let v = bytes.slice(i);
  if (v[0] & 0x80) v = concat([0], v);
  return concat([0x02, v.length], v);
}

// WebCrypto ECDSA emits raw r||s; real authenticators emit DER — the fake must too.
export function rawToDer(raw) {
  const r = derInt(raw.slice(0, 32));
  const s = derInt(raw.slice(32));
  return concat([0x30, r.length + s.length], r, s);
}

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

export async function createAuthenticator({ rpId = "example.org", origin = "https://example.org", alg = "ES256", staticCounter = false } = {}) {
  const params = alg === "ES256"
    ? { name: "ECDSA", namedCurve: "P-256" }
    : { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
  const kp = await crypto.subtle.generateKey(params, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const cose = alg === "ES256"
    ? new Map([[1, 2], [3, -7], [-1, 1], [-2, b64urlDecode(jwk.x)], [-3, b64urlDecode(jwk.y)]])
    : new Map([[1, 3], [3, -257], [-1, b64urlDecode(jwk.n)], [-2, b64urlDecode(jwk.e)]]);
  const credId = crypto.getRandomValues(new Uint8Array(16));
  const rpIdHash = await sha256(new TextEncoder().encode(rpId));
  let counter = 0;

  const clientData = (type, challenge, o) => new TextEncoder().encode(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));

  function authData(flags, withCredential) {
    counter = staticCounter ? 0 : counter + 1;
    const head = new Uint8Array(37);
    head.set(rpIdHash);
    head[32] = flags;
    new DataView(head.buffer).setUint32(33, counter);
    if (!withCredential) return head;
    const coseBytes = cborEncode(cose);
    const out = new Uint8Array(37 + 16 + 2 + credId.length + coseBytes.length);
    out.set(head);
    new DataView(out.buffer).setUint16(53, credId.length);
    out.set(credId, 55);
    out.set(coseBytes, 55 + credId.length);
    return out;
  }

  async function sign(data) {
    if (alg === "ES256") return rawToDer(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, data)));
    return new Uint8Array(await crypto.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, kp.privateKey, data));
  }

  const id = b64urlEncode(credId);
  return {
    credentialId: id,
    get counter() { return counter; },
    async create(challenge, { origin: o = origin, type = "webauthn.create" } = {}) {
      const cd = clientData(type, challenge, o);
      const att = cborEncode(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(0x45, true)]]));
      return { id, rawId: id, type: "public-key", response: { clientDataJSON: b64urlEncode(cd), attestationObject: b64urlEncode(att), transports: ["internal"] } };
    },
    async get(challenge, { origin: o = origin, type = "webauthn.get", counterOverride, tamper = false } = {}) {
      const cd = clientData(type, challenge, o);
      const ad = authData(0x05, false);
      if (counterOverride !== undefined) new DataView(ad.buffer).setUint32(33, counterOverride);
      const sig = await sign(concat(ad, await sha256(cd)));
      if (tamper) sig[sig.length - 1] ^= 0x01;
      return { id, rawId: id, type: "public-key", response: { clientDataJSON: b64urlEncode(cd), authenticatorData: b64urlEncode(ad), signature: b64urlEncode(sig), userHandle: null } };
    },
  };
}
