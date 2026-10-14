import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";

const COOKIE = "fp_session";
const SESSION_DAYS = 30;

let cachedSecret = null;
async function getSecret() {
  if (cachedSecret) return cachedSecret;
  if (process.env.SESSION_SECRET) { cachedSecret = process.env.SESSION_SECRET; return cachedSecret; }
  try {
    const meta = getStore("footprint-meta");
    let s = await meta.get("session-secret", { consistency: "strong" });
    if (!s) {
      s = crypto.randomBytes(32).toString("hex");
      await meta.set("session-secret", s);
    }
    cachedSecret = s;
  } catch {
    cachedSecret = "fallback-insecure-secret";
  }
  return cachedSecret;
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}
function sign(payload, sec) {
  const body = b64url(JSON.stringify(payload));
  const mac = b64url(crypto.createHmac("sha256", sec).update(body).digest());
  return body + "." + mac;
}
function verify(token, sec) {
  if (!token || token.indexOf(".") < 0) return null;
  const [body, mac] = token.split(".");
  const expect = b64url(crypto.createHmac("sha256", sec).update(body).digest());
  if (mac.length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
    const payload = JSON.parse(fromB64url(body).toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}
function parseCookies(req) {
  const out = {};
  (req.headers.get("cookie") || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function sessionCookie(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
const validUsername = (u) => /^[A-Za-z0-9_\u4e00-\u9fa5]{2,24}$/.test(u);

function currentUser(req, sec) {
  const payload = verify(parseCookies(req)[COOKIE], sec);
  return payload ? payload.u : null;
}

function cleanPoints(raw) {
  if (!Array.isArray(raw)) return null;
  if (raw.length > 2000) return null;
  const out = [];
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lat = Number(p[0]);
    const lng = Number(p[1]);
    if (!isFinite(lat) || !isFinite(lng)) continue;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    let name = (p[2] == null ? "" : String(p[2])).slice(0, 100).trim();
    out.push([Number(lat.toFixed(6)), Number(lng.toFixed(6)), name]);
  }
  return out;
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const method = req.method.toUpperCase();

  if (path === "" || path === "health") return json({ ok: true, service: "footprint" });

  const sec = await getSecret();
  const users = getStore("footprint-users");
  const dataStore = getStore("footprint-data");

  if (path === "debug") {
    return json({ error: "disabled" }, 404);
  }

  // ---- 注册 ----
  if (path === "register" && method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "请求格式错误" }, 400); }
    const username = String(body?.username ?? "").trim();
    const password = String(body?.password ?? "");
    if (!validUsername(username)) return json({ error: "用户名需 2-24 位（中英文/数字/下划线）" }, 400);
    if (password.length < 6) return json({ error: "密码至少 6 位" }, 400);
    if (await users.get(username, { type: "json", consistency: "strong" })) return json({ error: "该用户名已被注册" }, 409);
    const salt = crypto.randomBytes(16).toString("hex");
    await users.setJSON(username, {
      salt,
      hash: hashPassword(password, salt),
      createdAt: new Date().toISOString(),
    });
    await dataStore.setJSON(username, []);
    const token = sign({ u: username, exp: Date.now() + SESSION_DAYS * 86400000 }, sec);
    return json({ ok: true, username }, 200, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) });
  }

  // ---- 登录 ----
  if (path === "login" && method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "请求格式错误" }, 400); }
    const username = String(body?.username ?? "").trim();
    const password = String(body?.password ?? "");
    const rec = await users.get(username, { type: "json", consistency: "strong" });
    if (!rec) return json({ error: "用户名或密码错误" }, 401);
    const h = hashPassword(password, rec.salt);
    const ok = h.length === rec.hash.length &&
      crypto.timingSafeEqual(Buffer.from(h), Buffer.from(rec.hash));
    if (!ok) return json({ error: "用户名或密码错误" }, 401);
    const token = sign({ u: username, exp: Date.now() + SESSION_DAYS * 86400000 }, sec);
    return json({ ok: true, username }, 200, { "set-cookie": sessionCookie(token, SESSION_DAYS * 86400) });
  }

  // ---- 退出 ----
  if (path === "logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0` });
  }

  // ---- 当前用户 ----
  if (path === "me" && method === "GET") {
    const u = currentUser(req, sec);
    if (!u) return json({ error: "未登录" }, 401);
    return json({ username: u });
  }

  // ---- 我的足迹 ----
  // ---- 地名搜索（高德，服务端代理；key 存 Blobs，不暴露给前端）----
  if (path === "geocode" && method === "GET") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return json({ items: [] });
    try {
      const meta = getStore("footprint-meta");
      const key = await meta.get("amap-key", { consistency: "strong" });
      if (!key) return json({ error: "未配置地图搜索密钥" }, 503);
      const r = await fetch(
        "https://restapi.amap.com/v3/place/text?key=" + key +
        "&keywords=" + encodeURIComponent(q) + "&offset=6&page=1&extensions=base"
      );
      const d = await r.json();
      const pois = Array.isArray(d.pois) ? d.pois : [];
      const items = pois.map((p) => {
        const parts = String(p.location || ",").split(",");
        return {
          name: p.name,
          address: [p.pname, p.cityname, p.adname, p.address].filter(Boolean).join(""),
          lon: parseFloat(parts[0]),
          lat: parseFloat(parts[1]),
        };
      }).filter((x) => isFinite(x.lat) && isFinite(x.lon));
      return json({ items });
    } catch {
      return json({ error: "搜索服务异常" }, 502);
    }
  }

  if (path === "footprints") {
    const u = currentUser(req, sec);
    if (!u) return json({ error: "未登录" }, 401);
    if (method === "GET") {
      const list = (await dataStore.get(u, { type: "json", consistency: "strong" })) || [];
      return json(Array.isArray(list) ? list : []);
    }
    if (method === "POST" || method === "PUT") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "请求格式错误" }, 400); }
      const points = cleanPoints(body);
      if (!points) return json({ error: "数据格式错误（需 JSON 数组，最多 2000 条）" }, 400);
      await dataStore.setJSON(u, points);
      return json({ ok: true, count: points.length });
    }
  }

  return json({ error: "not found" }, 404);
};

export const config = { path: "/api/*" };
