// Gestion de flotte : notifications pour les admins (CT, fin de location, véhicule non rendu).
// À coller dans Supabase > Edge Functions > Deploy a new function > Via Editor, nom de la fonction : alertes.
// Aucune clé à saisir : les clés d'envoi sont créées automatiquement et gardées dans la base.

const URL_SB = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const SEUILS = [30, 7];          // jours avant l'échéance (CT, fin de location)
const SORTIE_MAX_JOURS = 3;      // au-delà, un véhicule sorti est signalé comme non rendu

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

/* ---------- Accès à la base (droits du service, jamais exposés au navigateur) ---------- */
async function rest(path: string, init: RequestInit = {}) {
  const r = await fetch(`${URL_SB}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`${path} : ${r.status} ${txt}`);
  return txt ? JSON.parse(txt) : null;
}
async function prive(cle: string): Promise<string | null> {
  const rows = await rest(`notif_prive?cle=eq.${encodeURIComponent(cle)}&select=valeur`);
  return rows.length ? rows[0].valeur : null;
}
async function setPrive(cle: string, valeur: string, remplacer = true) {
  await rest("notif_prive?on_conflict=cle", {
    method: "POST",
    headers: { Prefer: `resolution=${remplacer ? "merge" : "ignore"}-duplicates,return=minimal` },
    body: JSON.stringify({ cle, valeur }),
  });
}

/* ---------- Encodage ---------- */
const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

/* ---------- Clés VAPID (créées une seule fois) ---------- */
async function clesVapid() {
  let pub = await prive("vapid_public"), jwk = await prive("vapid_private");
  if (!pub || !jwk) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    await setPrive("vapid_private", JSON.stringify(await crypto.subtle.exportKey("jwk", kp.privateKey)), false);
    await setPrive("vapid_public", b64u(await crypto.subtle.exportKey("raw", kp.publicKey)), false);
    pub = await prive("vapid_public"); jwk = await prive("vapid_private"); // si deux appels simultanés, on garde la première paire
  }
  const key = await crypto.subtle.importKey("jwk", JSON.parse(jwk!), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { pub: pub!, key };
}

/* ---------- Envoi Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) ---------- */
async function hkdf(salt: BufferSource, ikm: BufferSource, info: BufferSource, bytes: number) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, bytes * 8));
}
export async function chiffrer(payload: Uint8Array, p256dh: string, auth: string) {
  const uaPub = unb64u(p256dh), secret = unb64u(auth);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const ua = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: ua }, eph.privateKey, 256));
  const ikm = await hkdf(secret, shared, concat(enc.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, concat(payload, new Uint8Array([2]))));
  const head = new Uint8Array(21); head.set(salt); new DataView(head.buffer).setUint32(16, 4096); head[20] = 65;
  return concat(head, asPub, ct);
}
export async function enteteVapid(endpoint: string, vapid: { pub: string; key: CryptoKey }) {
  const u = new URL(endpoint);
  const part = (o: unknown) => b64u(enc.encode(JSON.stringify(o)));
  const data = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: u.origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: "mailto:flotte@example.com" })}`;
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, vapid.key, enc.encode(data));
  return `vapid t=${data}.${b64u(sig)}, k=${vapid.pub}`;
}
async function pousser(abos: any[], message: unknown) {
  const vapid = await clesVapid(), body = enc.encode(JSON.stringify(message));
  let ok = 0;
  for (const a of abos) {
    try {
      const r = await fetch(a.endpoint, {
        method: "POST",
        headers: { TTL: "86400", Urgency: "normal", "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream",
          Authorization: await enteteVapid(a.endpoint, vapid) },
        body: await chiffrer(body, a.p256dh, a.auth),
      });
      if (r.ok) ok++;
      else if (r.status === 404 || r.status === 410) await rest(`push_abonnements?endpoint=eq.${encodeURIComponent(a.endpoint)}`, { method: "DELETE" });
    } catch (_) { /* appareil injoignable : on réessaiera au prochain envoi */ }
  }
  return ok;
}
async function abonnementsAdmins() {
  const admins = (await rest("profils?role=eq.admin&select=user_id")).map((p: any) => p.user_id);
  if (!admins.length) return [];
  return rest(`push_abonnements?user_id=in.(${admins.join(",")})&select=endpoint,p256dh,auth`);
}

/* ---------- Ce qui mérite une alerte ---------- */
const jourParis = (d = new Date()) => d.toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" }); // AAAA-MM-JJ
const ecartJours = (de: string, a: string) => Math.round((Date.parse(a + "T00:00:00Z") - Date.parse(de + "T00:00:00Z")) / 86400e3);
const frDate = (ymd: string) => ymd.split("-").reverse().join("/");
const pluriel = (n: number, mot: string) => `${n} ${mot}${n > 1 ? "s" : ""}`;

export function calculerAlertes(vehicules: any[], maintenant = new Date()) {
  const auj = jourParis(maintenant), out: { cle: string; texte: string }[] = [];
  const echeance = (id: string, type: string, date: string, quoi: string, passe: string, nom: string) => {
    const j = ecartJours(auj, date);
    const palier = j < 0 ? "depasse" : SEUILS.slice().sort((a, b) => a - b).find((s) => j <= s);
    if (palier === undefined) return;
    const texte = j < 0 ? `${nom} : ${passe} depuis le ${frDate(date)}`
      : j === 0 ? `${nom} : ${quoi} aujourd'hui` : `${nom} : ${quoi} dans ${pluriel(j, "jour")} (${frDate(date)})`;
    out.push({ cle: `${type}:${id}:${date}:${palier}`, texte });
  };
  for (const row of vehicules) {
    const v = row.data || {}, nom = v.plaque || `${v.marque || ""} ${v.modele || ""}`.trim();
    if (v.statut === "restitue") continue; // véhicule rendu : plus d'alerte
    if (v.prochainCT) echeance(row.id, "ct", v.prochainCT, "contrôle technique", "contrôle technique dépassé", nom);
    if (v.acquisition === "location" && v.locFin) echeance(row.id, "loc", v.locFin, "fin de location", "location terminée", nom);
    if (v.statut === "sortie" && v.depuis) {
      const j = Math.floor((maintenant.getTime() - Date.parse(v.depuis)) / 86400e3);
      if (j >= SORTIE_MAX_JOURS) out.push({ cle: `sortie:${row.id}:${v.depuis}`, texte: `${nom} : sorti depuis ${pluriel(j, "jour")}${v.conducteur ? ` par ${v.conducteur}` : ""}, pas encore rendu` });
    }
  }
  return out;
}

async function verifier() {
  const alertes = calculerAlertes(await rest("vehicules?select=id,data"));
  if (!alertes.length) return { alertes: 0, envoyes: 0 };
  const deja = new Set((await rest("notif_envoyees?select=cle")).map((x: any) => x.cle));
  const nouvelles = alertes.filter((a) => !deja.has(a.cle));
  if (!nouvelles.length) return { alertes: 0, envoyes: 0 };
  const lignes = nouvelles.map((a) => a.texte);
  const message = nouvelles.length === 1
    ? { title: "Gestion de flotte", body: lignes[0], tag: "flotte-alertes" }
    : { title: `Gestion de flotte : ${nouvelles.length} alertes`, body: lignes.slice(0, 4).join("\n") + (lignes.length > 4 ? `\net ${lignes.length - 4} autre(s)…` : ""), tag: "flotte-alertes" };
  const envoyes = await pousser(await abonnementsAdmins(), message);
  if (envoyes) await rest("notif_envoyees", { method: "POST", headers: { Prefer: "resolution=ignore-duplicates,return=minimal" }, body: JSON.stringify(nouvelles.map((a) => ({ cle: a.cle }))) });
  return { alertes: nouvelles.length, envoyes };
}

/* ---------- Qui appelle ---------- */
async function utilisateur(req: Request) {
  const jwt = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt === ANON) return null;
  const r = await fetch(`${URL_SB}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${jwt}` } });
  if (!r.ok) return null;
  const u = await r.json();
  const p = await rest(`profils?user_id=eq.${u.id}&select=role`);
  return { id: u.id as string, admin: p.length > 0 && p[0].role === "admin" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const { action } = await req.json().catch(() => ({}));
    if (action === "verifier") {
      const secret = await prive("cron_secret");
      const appelCron = secret && req.headers.get("x-cron-secret") === secret;
      if (!appelCron && !(await utilisateur(req))?.admin) return json({ error: "Réservé aux administrateurs." }, 403);
      return json(await verifier());
    }
    const u = await utilisateur(req);
    if (!u) return json({ error: "Connexion requise." }, 401);
    if (action === "cle") {
      // Mémorise l'adresse de la fonction pour la vérification quotidienne programmée dans la base.
      await setPrive("url_fonction", `${URL_SB}/functions/v1/alertes`);
      await setPrive("anon_key", ANON);
      return json({ publicKey: (await clesVapid()).pub });
    }
    if (action === "test") {
      if (!u.admin) return json({ error: "Réservé aux administrateurs." }, 403);
      const abos = await rest(`push_abonnements?user_id=eq.${u.id}&select=endpoint,p256dh,auth`);
      const envoyes = await pousser(abos, { title: "Gestion de flotte", body: "Les notifications fonctionnent sur cet appareil.", tag: "flotte-test" });
      return json({ appareils: abos.length, envoyes });
    }
    return json({ error: "Action inconnue." }, 400);
  } catch (e) {
    return json({ error: String((e as Error).message || e) }, 500);
  }
});
