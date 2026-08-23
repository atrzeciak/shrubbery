export class ApiError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

let stepUpHandler = null;
export function onStepUp(fn) { stepUpHandler = fn; }

export async function api(path, { method = "GET", body } = {}, allowStepUp = true) {
  const init = { method, credentials: "same-origin", headers: {} };
  if (body instanceof Blob) { init.headers["content-type"] = body.type || "application/octet-stream"; init.body = body; }
  else if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  const res = await fetch(path, init);
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (res.ok) return data;
  const code = (data && data.error) || "internal";
  if (res.status === 401 && code === "step_up_required" && allowStepUp && stepUpHandler && (await stepUpHandler())) {
    return api(path, { method, body }, false);
  }
  const e = new ApiError(res.status, code);
  e.detail = data;
  throw e;
}

const enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const dec = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0));

export const passkeysSupported = () => typeof PublicKeyCredential !== "undefined";

export async function passkeyGet() {
  const { challenge, rpId } = await api("/api/auth/passkey/challenge", { method: "POST", body: {} });
  const cred = await navigator.credentials.get({
    publicKey: { challenge: dec(challenge), rpId, allowCredentials: [], userVerification: "preferred", timeout: 60000 },
  });
  return {
    id: cred.id, rawId: enc(cred.rawId), type: cred.type,
    response: {
      authenticatorData: enc(cred.response.authenticatorData),
      clientDataJSON: enc(cred.response.clientDataJSON),
      signature: enc(cred.response.signature),
      userHandle: cred.response.userHandle ? enc(cred.response.userHandle) : null,
    },
  };
}

export async function passkeyCreate({ id, email }) {
  const { challenge, rpId } = await api("/api/auth/passkey/challenge", { method: "POST", body: {} });
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: dec(challenge),
      rp: { id: rpId, name: "Nasze Korzenie" },
      user: { id: new TextEncoder().encode(id), name: email, displayName: email },
      pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
      authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
      attestation: "none",
      timeout: 60000,
    },
  });
  return {
    id: cred.id, rawId: enc(cred.rawId), type: cred.type,
    response: {
      attestationObject: enc(cred.response.attestationObject),
      clientDataJSON: enc(cred.response.clientDataJSON),
      transports: typeof cred.response.getTransports === "function" ? cred.response.getTransports() : [],
    },
  };
}

export async function stepUp() {
  const credential = await passkeyGet();
  await api("/api/auth/passkey/step-up", { method: "POST", body: { credential } }, false);
}
