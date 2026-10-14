// Cloudflare Pages Functions - /api/visit
// 访客来访打点：10分钟 IP 防抖后推送微信；
// 推送失败(ilinkai ret:-2 等)→ 写入 KV 待补发队列 pending:*，等用户上线补发；
// 所有来访记录全部存档到 KV  log:*（永久，供"所有上线记录都存着"）。

export async function onRequest(context) {
  const { request, env } = context;

  const CORS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      }
    });
  }

  let site = "beento";
  let path = "/";
  if (request.method === "POST") {
    try {
      const body = await request.json();
      site = body.site || site;
      path = body.path || path;
    } catch (e) {}
  } else {
    const u = new URL(request.url);
    site = u.searchParams.get("site") || site;
    path = u.searchParams.get("path") || path;
  }

  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  const country = request.headers.get("cf-ipcountry") || "CN";
  const city = request.headers.get("cf-ipcity") || "";
  const ua = (request.headers.get("user-agent") || "").substring(0, 200);
  const KV = env.BEENTO_KV;

  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const timeStr = now.toISOString().replace("T", " ").substring(0, 19);
  const ts = Date.now();

  const siteNames = {
    "beento": "足迹地图 (beento)",
    "mkt": "牛熊温度计 (mkt)",
    "etf": "ETF热力图 (etf)"
  };
  const siteDisplay = siteNames[site] || site;
  const loc = city ? `${country}·${city}` : country;

  // 记录对象（存档 + 推送共用）
  const rec = { ts, time: timeStr, site, path, ip, country, city, loc, ua };

  // 1. IP 防抖：同一 IP、同一站点，10 分钟内只通知一次
  let rateLimited = false;
  if (KV) {
    const key = `rate:${site}:${ip}`;
    if (await KV.get(key)) {
      rateLimited = true;
    } else {
      await KV.put(key, "1", { expirationTtl: 600 });
    }
  }

  // 2. 存档所有来访（"所有上线记录都存着"）— 永久保留
  if (KV && !rateLimited) {
    context.waitUntil(
      KV.put(`log:${ts}:${site}`, JSON.stringify(rec))
    );
  }

  if (rateLimited) {
    return new Response(JSON.stringify({ ok: true, rate_limited: true }), { headers: CORS });
  }

  // 3. 组装推送文本
  const text = `👀 网站来访提醒\n━━━━━━━━━━━━\n📌 站点: ${siteDisplay}\n🔗 页面: ${path}\n📍 访客: ${loc} (${ip})\n🕒 时间: ${timeStr}`;

  // 4. 直连微信 ilinkai 机器人接口推送；失败入队待补发
  const result = await (async () => {
    try {
      const token = "115d959203e3@im.bot:060000ae53aad1cd3af2bb4eefc3c6c4be55bc";
      const to = "o9cq805zBtrZejJhXjQfo9LoiP3I@im.wechat";
      const base = "https://ilinkai.weixin.qq.com";
      const appid = "bot";
      const cv = 0;
      const uinNum = Math.floor(Math.random() * 4294967295);
      const uinB64 = btoa(String(uinNum));
      const body = {
        msg: {
          from_user_id: "",
          to_user_id: to,
          client_id: `visit-${ts}-${Math.floor(Math.random() * 10000)}`,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text } }]
        }
      };
      const resp = await fetch(`${base}/ilink/bot/sendmessage`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "AuthorizationType": "ilink_bot_token",
          "Authorization": `Bearer ${token}`,
          "X-WECHAT-UIN": uinB64,
          "iLink-App-Id": appid,
          "iLink-App-ClientVersion": String(cv)
        },
        body: JSON.stringify(body)
      });
      const txt = await resp.text();
      // 服务器受理会返回真实 message_id；失败通常 ret:-2 prepare failed
      const delivered = resp.status === 200 && txt.includes("message_id");
      return { delivered, http: resp.status, resp: txt.substring(0, 200) };
    } catch (err) {
      return { delivered: false, http: 0, resp: String(err).substring(0, 200) };
    }
  })();

  // 5. 推送失败 → 入队，等用户上线补发
  if (!result.delivered && KV) {
    context.waitUntil(
      KV.put(`pending:${ts}:${site}`, JSON.stringify({ ...rec, text, pushResp: result.resp }))
    );
  }

  return new Response(
    JSON.stringify({
      ok: true,
      notified: result.delivered,
      queued: !result.delivered,
      http: result.http
    }),
    { headers: CORS }
  );
}
