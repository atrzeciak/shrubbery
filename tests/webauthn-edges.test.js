import { describe, expect, it } from "vitest";
import { cborEncode, concat, createAuthenticator } from "./helpers/authenticator.js";
import { b64urlDecode, b64urlEncode } from "../src/util.js";
import { cborDecode, importCoseKey, newChallenge, verifyAssertion, verifyRegistration, WebAuthnError } from "../src/auth/webauthn.js";

const SITE = { expectedOrigin: "https://example.org", rpId: "example.org" };
const rejects = async (p, code) => {
  await expect(p).rejects.toBeInstanceOf(WebAuthnError);
  await expect(p).rejects.toMatchObject({ code });
};
const throws = (fn, code) => {
  let caught;
  try { fn(); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(WebAuthnError);
  expect(caught).toMatchObject({ code });
};

// Registration and assertion payloads as a browser would hand them over, from parts this test controls.
const clientData = (type, challenge) => b64urlEncode(new TextEncoder().encode(JSON.stringify({ type, challenge, origin: SITE.expectedOrigin })));
const register = (attestation, challenge) => verifyRegistration({ ...SITE, attestationObject: b64urlEncode(attestation), clientDataJSON: clientData("webauthn.create", challenge), expectedChallenge: challenge });

async function authDataWithFlags(flags) {
  const out = new Uint8Array(37);
  out.set(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(SITE.rpId))));
  out[32] = flags;
  return out;
}

describe("cbor corners", () => {
  it("decodes the simple values false, true and null", () => {
    expect(cborDecode(new Uint8Array([0xf4]))[0]).toBe(false);
    expect(cborDecode(new Uint8Array([0xf5]))[0]).toBe(true);
    expect(cborDecode(new Uint8Array([0xf6]))[0]).toBe(null);
  });

  it("refuses floats, tags, reserved additional info and an empty buffer", () => {
    throws(() => cborDecode(new Uint8Array([0xfa, 0, 0, 0, 0])), "bad_cbor");   // float32
    throws(() => cborDecode(new Uint8Array([0xc0, 0x01])), "bad_cbor");         // tag
    throws(() => cborDecode(new Uint8Array([0x1c])), "bad_cbor");               // uint, ai 28
    throws(() => cborDecode(new Uint8Array([])), "bad_cbor");
  });

  it("refuses a length prefix cut off mid-way, for every prefix width", () => {
    for (const head of [[0x18], [0x19, 0], [0x1a, 0, 0, 0], [0x1b, 0, 0, 0, 0, 0, 0, 0]]) {
      throws(() => cborDecode(new Uint8Array(head)), "bad_cbor");
    }
  });

  it("refuses a text string cut off before its declared end", () => {
    throws(() => cborDecode(new Uint8Array([0x63, 0x61, 0x62])), "bad_cbor");
  });

  it("reads 64-bit and 32-bit length prefixes when the bytes are all there", () => {
    expect(cborDecode(new Uint8Array([0x1b, 0, 0, 0, 0, 0, 0, 1, 0]))[0]).toBe(256);
    expect(cborDecode(new Uint8Array([0x1a, 0, 0, 1, 0]))[0]).toBe(256);
  });
});

describe("registration shapes", () => {
  it("refuses an attestation object that is not a map with authData", async () => {
    const ch = newChallenge();
    await rejects(register(cborEncode([1, 2]), ch), "bad_attestation");
    await rejects(register(cborEncode(new Map([["fmt", "none"]])), ch), "bad_attestation");
  });

  it("refuses a registration whose authenticator never saw the user", async () => {
    const ch = newChallenge();
    const att = cborEncode(new Map([["authData", await authDataWithFlags(0x00)]]));
    await rejects(register(att, ch), "user_not_present");
  });

  it("refuses authenticator data whose credential id runs past the end", async () => {
    const ch = newChallenge();
    const authData = concat(await authDataWithFlags(0x41), new Uint8Array(16), [0x01, 0x00]);   // aaguid, then a 256-byte id that is not there
    await rejects(register(cborEncode(new Map([["authData", authData]])), ch), "bad_auth_data");
  });

  it("refuses a registration that carries no credential", async () => {
    const ch = newChallenge();
    const att = cborEncode(new Map([["authData", await authDataWithFlags(0x01)]]));
    await rejects(register(att, ch), "no_credential");
  });

  it("refuses client data that is not JSON", async () => {
    const auth = await createAuthenticator();
    const ch = newChallenge();
    const cred = await auth.create(ch);
    await rejects(verifyRegistration({ ...SITE, attestationObject: cred.response.attestationObject, clientDataJSON: b64urlEncode(new TextEncoder().encode("{nope")), expectedChallenge: ch }), "bad_client_data");
  });
});

describe("key import", () => {
  // Some authenticators drop the leading zero of an EC coordinate. Keys are generated until one
  // turns up whose x starts with 0x00, then that byte is stripped the way such an authenticator would.
  it("accepts an EC key whose coordinate lost its leading zero byte", async () => {
    let kp, jwk;
    for (let i = 0; i < 5000; i++) {
      kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
      jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
      if (b64urlDecode(jwk.x)[0] === 0) break;
    }
    const x = b64urlDecode(jwk.x);
    expect(x[0]).toBe(0);
    const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, x.slice(1)], [-3, b64urlDecode(jwk.y)]]);
    const { alg, key } = await importCoseKey(cborEncode(cose));
    expect(alg).toBe(-7);
    const data = new TextEncoder().encode("signed");
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, kp.privateKey, data);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, data)).toBe(true);
  });

  it("refuses an EC key whose coordinates are not a point on the curve", async () => {
    const cose = new Map([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(32).fill(0xff)], [-3, new Uint8Array(32).fill(0xff)]]);
    await rejects(importCoseKey(cborEncode(cose)), "unsupported_key");
  });

  it("refuses an RSA key whose modulus is nonsense", async () => {
    const cose = new Map([[1, 3], [3, -257], [-1, new Uint8Array([0])], [-2, new Uint8Array([1, 0, 1])]]);
    await rejects(importCoseKey(cborEncode(cose)), "unsupported_key");
  });

  it("refuses an EC key on a curve it does not speak", async () => {
    const cose = new Map([[1, 2], [3, -7], [-1, 2], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]]);
    await rejects(importCoseKey(cborEncode(cose)), "unsupported_key");
  });
});

describe("assertion shapes", () => {
  async function registered(alg = "ES256") {
    const auth = await createAuthenticator({ alg });
    const ch = newChallenge();
    const cred = await auth.create(ch);
    const reg = await verifyRegistration({ ...SITE, attestationObject: cred.response.attestationObject, clientDataJSON: cred.response.clientDataJSON, expectedChallenge: ch });
    return { auth, reg };
  }

  it("refuses a signature that is not DER at all, without crashing", async () => {
    const { auth, reg } = await registered();
    const ch = newChallenge();
    const a = await auth.get(ch);
    await rejects(verifyAssertion({ ...SITE, ...a.response, signature: b64urlEncode(new Uint8Array([1, 2, 3])), publicKey: reg.publicKey, expectedChallenge: ch, prevCounter: 1 }), "bad_signature");
  });

  // DER allows the sequence length in long form (0x81 nn); some libraries emit it for signatures near 128 bytes.
  it("reads a signature whose sequence length is written in long form", async () => {
    const { auth, reg } = await registered();
    const ch = newChallenge();
    const a = await auth.get(ch);
    const der = b64urlDecode(a.response.signature);
    const longForm = concat([0x30, 0x81, der[1]], der.subarray(2));
    const r = await verifyAssertion({ ...SITE, ...a.response, signature: b64urlEncode(longForm), publicKey: reg.publicKey, expectedChallenge: ch, prevCounter: 1 });
    expect(r.counter).toBe(2);
  });

  it("refuses a DER sequence whose elements are not integers", async () => {
    const { auth, reg } = await registered();
    const ch = newChallenge();
    const a = await auth.get(ch);
    const der = b64urlDecode(a.response.signature);
    der[2] = 0x04;                                                              // octet string where r should be
    await rejects(verifyAssertion({ ...SITE, ...a.response, signature: b64urlEncode(der), publicKey: reg.publicKey, expectedChallenge: ch, prevCounter: 1 }), "bad_signature");
  });

  it("refuses a DER signature whose integers overflow the curve size", async () => {
    const { auth, reg } = await registered();
    const ch = newChallenge();
    const a = await auth.get(ch);
    const big = concat([0x02, 34, 1, 1], new Uint8Array(32));
    const der = concat([0x30, big.length * 2], big, big);
    await rejects(verifyAssertion({ ...SITE, ...a.response, signature: b64urlEncode(der), publicKey: reg.publicKey, expectedChallenge: ch, prevCounter: 1 }), "bad_signature");
  });

  it("refuses an RSA signature of the wrong length", async () => {
    const { auth, reg } = await registered("RS256");
    const ch = newChallenge();
    const a = await auth.get(ch);
    await rejects(verifyAssertion({ ...SITE, ...a.response, signature: b64urlEncode(new Uint8Array(16)), publicKey: reg.publicKey, expectedChallenge: ch, prevCounter: 1 }), "bad_signature");
  });

  it("refuses authenticator data too short to carry the flags and counter", async () => {
    const { auth, reg } = await registered();
    const ch = newChallenge();
    const a = await auth.get(ch);
    await rejects(verifyAssertion({ ...SITE, ...a.response, authenticatorData: b64urlEncode(new Uint8Array(20)), publicKey: reg.publicKey, expectedChallenge: ch, prevCounter: 1 }), "bad_auth_data");
  });
});
