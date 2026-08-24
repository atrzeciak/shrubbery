import { b64urlDecode, b64urlEncode, randomB64url } from "../util.js";

export const newChallenge = () => randomB64url(32);

export class WebAuthnError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const toU8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

// RFC 8949 subset: uint, negint, bytes, text, array, map, false/true/null.
const CBOR_MAX_DEPTH = 16;

export function cborDecode(input, offset = 0) {
  const bytes = toU8(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  function read(pos, depth = 0) {
    if (depth > CBOR_MAX_DEPTH) throw new WebAuthnError("bad_cbor");
    if (pos >= bytes.length) throw new WebAuthnError("bad_cbor");
    const ib = bytes[pos];
    const mt = ib >> 5;
    const ai = ib & 0x1f;
    let len = ai;
    pos += 1;
    if (ai === 24) { if (pos + 1 > bytes.length) throw new WebAuthnError("bad_cbor"); len = bytes[pos]; pos += 1; }
    else if (ai === 25) { if (pos + 2 > bytes.length) throw new WebAuthnError("bad_cbor"); len = view.getUint16(pos); pos += 2; }
    else if (ai === 26) { if (pos + 4 > bytes.length) throw new WebAuthnError("bad_cbor"); len = view.getUint32(pos); pos += 4; }
    else if (ai === 27) { if (pos + 8 > bytes.length) throw new WebAuthnError("bad_cbor"); len = Number(view.getBigUint64(pos)); pos += 8; }
    else if (ai > 27) throw new WebAuthnError("bad_cbor");
    switch (mt) {
      case 0: return [len, pos];
      case 1: return [-1 - len, pos];
      case 2: if (pos + len > bytes.length) throw new WebAuthnError("bad_cbor"); return [bytes.slice(pos, pos + len), pos + len];
      case 3: if (pos + len > bytes.length) throw new WebAuthnError("bad_cbor"); return [new TextDecoder().decode(bytes.slice(pos, pos + len)), pos + len];
      case 4: { const arr = []; for (let i = 0; i < len; i++) { const [v, p] = read(pos, depth + 1); arr.push(v); pos = p; } return [arr, pos]; }
      case 5: { const map = new Map(); for (let i = 0; i < len; i++) { const [k, p1] = read(pos, depth + 1); const [v, p2] = read(p1, depth + 1); map.set(k, v); pos = p2; } return [map, pos]; }
      case 7:
        if (ai === 20) return [false, pos];
        if (ai === 21) return [true, pos];
        if (ai === 22) return [null, pos];
        throw new WebAuthnError("bad_cbor");
      default: throw new WebAuthnError("bad_cbor");
    }
  }
  return read(offset);
}

export function parseAuthData(input) {
  const authData = toU8(input);
  if (authData.length < 37) throw new WebAuthnError("bad_auth_data");
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const flags = authData[32];
  const out = {
    rpIdHash: authData.slice(0, 32),
    flags,
    userPresent: !!(flags & 0x01),
    userVerified: !!(flags & 0x04),
    counter: view.getUint32(33),
  };
  if (flags & 0x40) {
    if (authData.length < 55) throw new WebAuthnError("bad_auth_data");
    const credIdLen = view.getUint16(53);
    if (authData.length < 55 + credIdLen) throw new WebAuthnError("bad_auth_data");
    out.aaguid = authData.slice(37, 53);
    out.credentialId = authData.slice(55, 55 + credIdLen);
    const keyStart = 55 + credIdLen;
    const [, end] = cborDecode(authData, keyStart);
    out.publicKey = authData.slice(keyStart, end);
  }
  return out;
}

// Some authenticators strip a leading zero from EC coordinates; JWK import needs fixed width.
function padTo32(bytes) {
  const u8 = toU8(bytes);
  if (u8.length >= 32) return u8;
  const out = new Uint8Array(32);
  out.set(u8, 32 - u8.length);
  return out;
}

export async function importCoseKey(input) {
  const [k] = cborDecode(toU8(input));
  const kty = k.get(1);
  const alg = k.get(3);
  if (kty === 2 && alg === -7 && k.get(-1) === 1) {
    const jwk = { kty: "EC", crv: "P-256", x: b64urlEncode(padTo32(k.get(-2))), y: b64urlEncode(padTo32(k.get(-3))) };
    try {
      return { alg, key: await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]) };
    } catch { throw new WebAuthnError("unsupported_key"); }
  }
  if (kty === 3 && alg === -257) {
    const jwk = { kty: "RSA", n: b64urlEncode(k.get(-1)), e: b64urlEncode(k.get(-2)), alg: "RS256" };
    try {
      return { alg, key: await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]) };
    } catch { throw new WebAuthnError("unsupported_key"); }
  }
  throw new WebAuthnError("unsupported_key");
}

// ECDSA signatures arrive DER-encoded; WebCrypto verifies raw r||s.
export function derToRaw(sig, size = 32) {
  if (sig[0] !== 0x30) throw new WebAuthnError("bad_signature");
  let pos = 2;
  if (sig[1] & 0x80) pos += sig[1] & 0x7f;
  const out = new Uint8Array(size * 2);
  for (let i = 0; i < 2; i++) {
    if (sig[pos] !== 0x02) throw new WebAuthnError("bad_signature");
    const len = sig[pos + 1];
    pos += 2;
    let val = sig.slice(pos, pos + len);
    pos += len;
    while (val.length > size && val[0] === 0) val = val.slice(1);
    if (val.length > size) throw new WebAuthnError("bad_signature");
    out.set(val, size * (i + 1) - val.length);
  }
  return out;
}

function checkClientData(bytes, expectedType, expectedChallenge, expectedOrigin) {
  let c;
  try { c = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new WebAuthnError("bad_client_data"); }
  if (c.type !== expectedType) throw new WebAuthnError("type_mismatch");
  if (c.challenge !== expectedChallenge) throw new WebAuthnError("challenge_mismatch");
  if (c.origin !== expectedOrigin) throw new WebAuthnError("origin_mismatch");
}

async function checkRpIdHash(auth, rpId) {
  const expected = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rpId)));
  if (expected.length !== auth.rpIdHash.length || expected.some((b, i) => b !== auth.rpIdHash[i])) throw new WebAuthnError("rp_id_mismatch");
  if (!auth.userPresent) throw new WebAuthnError("user_not_present");
}

export async function verifyRegistration({ attestationObject, clientDataJSON, expectedChallenge, expectedOrigin, rpId }) {
  const cd = b64urlDecode(clientDataJSON);
  checkClientData(cd, "webauthn.create", expectedChallenge, expectedOrigin);
  const [att] = cborDecode(b64urlDecode(attestationObject));
  if (!(att instanceof Map) || !att.get("authData")) throw new WebAuthnError("bad_attestation");
  const auth = parseAuthData(att.get("authData"));
  await checkRpIdHash(auth, rpId);
  if (!auth.credentialId) throw new WebAuthnError("no_credential");
  const { alg } = await importCoseKey(auth.publicKey);
  return { credentialId: b64urlEncode(auth.credentialId), publicKey: auth.publicKey, counter: auth.counter, alg };
}

export async function verifyAssertion({ authenticatorData, clientDataJSON, signature, publicKey, expectedChallenge, expectedOrigin, rpId, prevCounter }) {
  const cd = b64urlDecode(clientDataJSON);
  checkClientData(cd, "webauthn.get", expectedChallenge, expectedOrigin);
  const authData = b64urlDecode(authenticatorData);
  const auth = parseAuthData(authData);
  await checkRpIdHash(auth, rpId);
  const { alg, key } = await importCoseKey(publicKey);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", cd));
  const signed = new Uint8Array(authData.length + hash.length);
  signed.set(authData);
  signed.set(hash, authData.length);
  const sig = b64urlDecode(signature);
  let ok = false;
  try {
    ok = alg === -7
      ? await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, derToRaw(sig), signed)
      : await crypto.subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, sig, signed);
  } catch { ok = false; }
  if (!ok) throw new WebAuthnError("bad_signature");
  const prev = Number.isInteger(prevCounter) ? prevCounter : 0;
  if ((auth.counter !== 0 || prev !== 0) && auth.counter <= prev) throw new WebAuthnError("counter_regression");
  return { counter: auth.counter, userVerified: auth.userVerified };
}
