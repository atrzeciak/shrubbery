import { describe, it, expect } from "vitest";
import { createAuthenticator, cborEncode, rawToDer } from "./helpers/authenticator.js";
import { cborDecode, derToRaw, newChallenge, verifyRegistration, verifyAssertion, WebAuthnError, parseAuthData, importCoseKey } from "../src/auth/webauthn.js";

const SITE = { expectedOrigin: "https://example.org", rpId: "example.org" };
const rejects = async (p, code) => {
  await expect(p).rejects.toBeInstanceOf(WebAuthnError);
  await expect(p).rejects.toMatchObject({ code });
};

describe("cbor + der", () => {
  it("round-trips ints, negatives, bytes, text, arrays and maps", () => {
    const value = new Map([[1, 2], [3, -7], [-2, new Uint8Array([1, 2, 3])], ["fmt", "none"], ["arr", [0, 23, 24, 255, 256, 70000]]]);
    const [decoded, end] = cborDecode(cborEncode(value));
    expect(end).toBe(cborEncode(value).length);
    expect(decoded.get(1)).toBe(2);
    expect(decoded.get(3)).toBe(-7);
    expect([...decoded.get(-2)]).toEqual([1, 2, 3]);
    expect(decoded.get("fmt")).toBe("none");
    expect(decoded.get("arr")).toEqual([0, 23, 24, 255, 256, 70000]);
  });

  it("derToRaw inverts rawToDer, including high-bit and leading-zero cases", () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80; raw[31] = 1; raw[32] = 0; raw[33] = 0; raw[63] = 5;
    expect([...derToRaw(rawToDer(raw))]).toEqual([...raw]);
  });
});

describe("malformed input", () => {
  it("rejects auth data with the AT flag set but no room for a credential id length", () => {
    const authData = new Uint8Array(37);
    authData[32] = 0x45; // UP + AT flags
    let caught;
    try { parseAuthData(authData); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(WebAuthnError);
    expect(caught).toMatchObject({ code: "bad_auth_data" });
  });

  it("rejects cbor whose declared length overruns the buffer", () => {
    const truncated = new Uint8Array([0x58, 0x40, 1, 2, 3]); // byte string claims 64 bytes, only has 3
    let caught;
    try { cborDecode(truncated); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(WebAuthnError);
    expect(caught).toMatchObject({ code: "bad_cbor" });
  });

  it("rejects deeply nested cbor instead of overflowing the stack", () => {
    const nested = new Uint8Array(200_000).fill(0x81); // array-of-one, nested indefinitely
    let caught;
    try { cborDecode(nested); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(WebAuthnError);
    expect(caught).toMatchObject({ code: "bad_cbor" });
  });

  it("rejects an unsupported COSE algorithm", async () => {
    const key = new Map([[1, 2], [3, -8], [-1, 1], [-2, new Uint8Array(32)], [-3, new Uint8Array(32)]]);
    await rejects(importCoseKey(cborEncode(key)), "unsupported_key");
  });
});

describe("counter edge cases", () => {
  it("treats a non-numeric prevCounter as zero", async () => {
    const auth = await createAuthenticator({ staticCounter: true });
    const ch = newChallenge();
    const cred = await auth.create(ch);
    const reg = await verifyRegistration({ ...SITE, attestationObject: cred.response.attestationObject, clientDataJSON: cred.response.clientDataJSON, expectedChallenge: ch });
    expect(reg.counter).toBe(0);

    const ch2 = newChallenge();
    const a = await auth.get(ch2);
    const res = await verifyAssertion({ ...SITE, ...a.response, publicKey: reg.publicKey, expectedChallenge: ch2, prevCounter: undefined });
    expect(res.counter).toBe(0);

    const ch3 = newChallenge();
    const b = await auth.get(ch3);
    const res2 = await verifyAssertion({ ...SITE, ...b.response, publicKey: reg.publicKey, expectedChallenge: ch3, prevCounter: null });
    expect(res2.counter).toBe(0);
  });
});

for (const alg of ["ES256", "RS256"]) {
  describe(`webauthn ${alg}`, () => {
    it("registers, then verifies assertions with increasing counters", async () => {
      const auth = await createAuthenticator({ alg });
      const ch = newChallenge();
      const cred = await auth.create(ch);
      const reg = await verifyRegistration({ ...SITE, attestationObject: cred.response.attestationObject, clientDataJSON: cred.response.clientDataJSON, expectedChallenge: ch });
      expect(reg.credentialId).toBe(auth.credentialId);
      expect(reg.alg).toBe(alg === "ES256" ? -7 : -257);
      expect(reg.counter).toBe(1);
      expect(reg.publicKey).toBeInstanceOf(Uint8Array);

      const ch2 = newChallenge();
      const a = await auth.get(ch2);
      const res = await verifyAssertion({ ...SITE, ...a.response, publicKey: reg.publicKey, expectedChallenge: ch2, prevCounter: reg.counter });
      expect(res.counter).toBe(2);
      // D1 hands BLOBs back as ArrayBuffer — must be accepted too.
      const ch3 = newChallenge();
      const b = await auth.get(ch3);
      const asBuffer = reg.publicKey.buffer.slice(reg.publicKey.byteOffset, reg.publicKey.byteOffset + reg.publicKey.byteLength);
      const res2 = await verifyAssertion({ ...SITE, ...b.response, publicKey: asBuffer, expectedChallenge: ch3, prevCounter: res.counter });
      expect(res2.counter).toBe(3);
    });

    it("rejects wrong challenge, origin, type, rp id, tampered signature and counter regression", async () => {
      const auth = await createAuthenticator({ alg });
      const ch = newChallenge();
      const cred = await auth.create(ch);
      const reg = await verifyRegistration({ ...SITE, attestationObject: cred.response.attestationObject, clientDataJSON: cred.response.clientDataJSON, expectedChallenge: ch });

      await rejects(verifyRegistration({ ...SITE, attestationObject: cred.response.attestationObject, clientDataJSON: cred.response.clientDataJSON, expectedChallenge: newChallenge() }), "challenge_mismatch");
      const bad = await auth.create(ch, { origin: "https://evil.example" });
      await rejects(verifyRegistration({ ...SITE, attestationObject: bad.response.attestationObject, clientDataJSON: bad.response.clientDataJSON, expectedChallenge: ch }), "origin_mismatch");
      const badType = await auth.create(ch, { type: "webauthn.get" });
      await rejects(verifyRegistration({ ...SITE, attestationObject: badType.response.attestationObject, clientDataJSON: badType.response.clientDataJSON, expectedChallenge: ch }), "type_mismatch");
      await rejects(verifyRegistration({ ...SITE, attestationObject: cred.response.attestationObject, clientDataJSON: cred.response.clientDataJSON, expectedChallenge: ch, rpId: "other.example" }), "rp_id_mismatch");

      const ch2 = newChallenge();
      const t = await auth.get(ch2, { tamper: true });
      await rejects(verifyAssertion({ ...SITE, ...t.response, publicKey: reg.publicKey, expectedChallenge: ch2, prevCounter: 1 }), "bad_signature");
      const ch3 = newChallenge();
      const r = await auth.get(ch3, { counterOverride: 1 });
      await rejects(verifyAssertion({ ...SITE, ...r.response, publicKey: reg.publicKey, expectedChallenge: ch3, prevCounter: 1 }), "counter_regression");
      const ch4 = newChallenge();
      const w = await auth.get(ch4, { origin: "https://evil.example" });
      await rejects(verifyAssertion({ ...SITE, ...w.response, publicKey: reg.publicKey, expectedChallenge: ch4, prevCounter: 1 }), "origin_mismatch");
    });

    it("supports authenticators with a static zero signCount (e.g. Apple passkeys)", async () => {
      const auth = await createAuthenticator({ alg, staticCounter: true });
      const ch = newChallenge();
      const cred = await auth.create(ch);
      const reg = await verifyRegistration({ ...SITE, attestationObject: cred.response.attestationObject, clientDataJSON: cred.response.clientDataJSON, expectedChallenge: ch });
      expect(reg.counter).toBe(0);

      const ch2 = newChallenge();
      const a = await auth.get(ch2);
      const res = await verifyAssertion({ ...SITE, ...a.response, publicKey: reg.publicKey, expectedChallenge: ch2, prevCounter: 0 });
      expect(res.counter).toBe(0);

      const ch3 = newChallenge();
      const b = await auth.get(ch3);
      const res2 = await verifyAssertion({ ...SITE, ...b.response, publicKey: reg.publicKey, expectedChallenge: ch3, prevCounter: 0 });
      expect(res2.counter).toBe(0);
    });
  });
}
