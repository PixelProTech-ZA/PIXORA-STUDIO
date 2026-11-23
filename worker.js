// PIXORA API on Cloudflare Workers. The Magic Hour API key exists only as a Worker secret (MAGIC_HOUR_API_KEY).
const MH = "https://api.magichour.ai/v1";
const SNIFF = (b) => {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { mime: "image/png", ext: "png" };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { mime: "image/webp", ext: "webp" };
  return null;
};
const hits = new Map(); // best-effort per-isolate limiter; add a Cloudflare WAF rate-limit rule for a hard limit
const MAP = { face: "the person's face", hair: "the hairstyle", body: "body proportions", background: "the original background", composition: "the image composition", lighting: "the original lighting", identity: "the person's identity" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get("Origin") || "";
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim());
    const cors = {
      "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : allowed[0],
      "Access-Control-Allow-Headers": "x-pixora-key,content-type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Expose-Headers": "x-pixora-model",
      Vary: "Origin",
    };
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
    const fail = (s, error, message) => json({ error, message }, s);
    const maxMB = parseFloat(env.MAX_UPLOAD_MB) || 8;
    const model = env.MAGIC_HOUR_MODEL || "default";

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && !allowed.includes(origin)) return fail(403, "forbidden_origin", "This site is not allowed to use the PIXORA API.");

    if (url.pathname === "/api/config")
      return json({ maxUploadMB: maxMB, model, configured: !!env.MAGIC_HOUR_API_KEY, requiresKey: !!env.PIXORA_ACCESS_KEY });
    if (url.pathname !== "/api/transform" || req.method !== "POST") return fail(404, "not_found", "Not found.");

    if (env.PIXORA_ACCESS_KEY && req.headers.get("x-pixora-key") !== env.PIXORA_ACCESS_KEY) return fail(401, "unauthorized", "Access key missing or incorrect. Add it in Settings.");
    const ip = req.headers.get("CF-Connecting-IP") || "x", now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= (parseInt(env.RATE_LIMIT_PER_MIN) || 6)) return fail(429, "rate_limited", "Too many requests. Wait a minute and try again.");
    hits.set(ip, [...recent, now]);
    if (!env.MAGIC_HOUR_API_KEY) return fail(503, "not_configured", "The server has no Magic Hour API key configured.");

    let form;
    try { form = await req.formData(); } catch { return fail(400, "upload_error", "The upload could not be read."); }
    const file = form.get("image");
    if (!file || typeof file === "string") return fail(400, "no_image", "Upload an image first.");
    if (file.size > maxMB * 1048576) return fail(413, "too_large", `Image exceeds the ${maxMB} MB limit.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const kind = SNIFF(bytes);
    if (!kind) return fail(415, "bad_format", "Unsupported image. Use JPG, PNG or WEBP.");
    let prompt = String(form.get("prompt") || "").trim().slice(0, 1000);
    if (!prompt) return fail(400, "no_prompt", "Describe what should change.");
    let keep = []; try { keep = JSON.parse(form.get("preserve") || "[]"); } catch {}
    const list = keep.filter((k) => MAP[k]).map((k) => MAP[k]);
    if (list.length) prompt += `. Keep unchanged: ${list.join(", ")}. Change only what was requested.`;

    const auth = { Authorization: `Bearer ${env.MAGIC_HOUR_API_KEY}`, Accept: "application/json" };
    const ctl = new AbortController(), timeoutMs = parseInt(env.TIMEOUT_MS) || 100000;
    const timer = setTimeout(() => ctl.abort(), timeoutMs);

    // Map a failed Magic Hour response to a PIXORA error.
    const mhError = async (r) => {
      let d = ""; try { const j = await r.json(); d = j?.message || j?.error?.message || j?.error || ""; } catch {}
      d = String(d).slice(0, 300);
      if (r.status === 401) return fail(502, "mh_auth", "Magic Hour rejected the server API key.");
      if (r.status === 402) return fail(502, "quota", "Magic Hour credits or plan limit reached.");
      if (r.status === 429) return fail(429, "mh_rate", "Magic Hour is rate limiting requests. Try again shortly.");
      if ([400, 404, 422].includes(r.status)) return fail(502, "unsupported_request", `Magic Hour rejected this request. ${d}`);
      return fail(502, "generation_failed", `Image generation failed (${r.status}). ${d}`);
    };

    try {
      // 1. Ask for a pre-signed upload URL.
      const up = await fetch(`${MH}/files/upload-urls`, { method: "POST", signal: ctl.signal,
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ items: [{ type: "image", extension: kind.ext }] }) });
      if (!up.ok) return await mhError(up);
      const slot = (await up.json())?.items?.[0];
      if (!slot?.upload_url || !slot?.file_path) return fail(502, "invalid_response", "Magic Hour did not return an upload URL.");

      // 2. Upload the photo bytes (auth is inside the signed URL, so no Authorization header here).
      const put = await fetch(slot.upload_url, { method: "PUT", body: bytes, signal: ctl.signal });
      if (!put.ok) return fail(502, "upload_failed", `Could not upload the image to Magic Hour (${put.status}).`);

      // 3. Start the edit job.
      const cr = await fetch(`${MH}/ai-image-editor`, { method: "POST", signal: ctl.signal,
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "PIXORA edit", image_count: 1, model, aspect_ratio: "auto",
          style: { prompt }, assets: { image_file_paths: [slot.file_path] } }) });
      if (!cr.ok) return await mhError(cr);
      const id = (await cr.json())?.id;
      if (!id) return fail(502, "invalid_response", "Magic Hour did not return a project id.");

      // 4. Poll until the job finishes.
      let out = null;
      while (!out) {
        await sleep(3000);
        const pr = await fetch(`${MH}/image-projects/${id}`, { headers: auth, signal: ctl.signal });
        if (!pr.ok) return await mhError(pr);
        const p = await pr.json();
        if (p.status === "complete") {
          out = p.downloads?.[0]?.url;
          if (!out) return fail(502, "invalid_response", "The edit finished but no image was returned.");
        } else if (p.status === "error") {
          return fail(502, "generation_failed", `Image generation failed. ${String(p.error?.message || "").slice(0, 300)}`);
        } else if (p.status === "canceled") {
          return fail(502, "generation_failed", "The edit was canceled.");
        }
      }

      // 5. Stream the finished image back to the browser.
      const ir = await fetch(out, { signal: ctl.signal }), it = ir.headers.get("content-type") || "";
      if (!ir.ok || !it.startsWith("image/")) return fail(502, "invalid_response", "The edited image could not be downloaded.");
      return new Response(ir.body, { headers: { ...cors, "Content-Type": it, "X-Pixora-Model": model, "Cache-Control": "no-store" } });
    } catch (e) {
      return e.name === "AbortError" ? fail(504, "timeout", "The edit took too long. Try again.") : fail(502, "network", "Could not reach Magic Hour.");
    } finally { clearTimeout(timer); }
  },
};
