// PIXORA API on Cloudflare Workers. The Hugging Face token exists only as a Worker secret.
const MAGIC = (b) => {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
};
const hits = new Map(); // best-effort per-isolate limiter; add a Cloudflare WAF rate-limit rule for a hard limit
const MAP = { face: "the person's face", hair: "the hairstyle", body: "body proportions", background: "the original background", composition: "the image composition", lighting: "the original lighting", identity: "the person's identity" };

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

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (origin && !allowed.includes(origin)) return fail(403, "forbidden_origin", "This site is not allowed to use the PIXORA API.");

    if (url.pathname === "/api/config")
      return json({ maxUploadMB: maxMB, model: env.HF_MODEL_ID || null, configured: !!(env.HF_API_TOKEN && env.HF_MODEL_ID), requiresKey: !!env.PIXORA_ACCESS_KEY });
    if (url.pathname !== "/api/transform" || req.method !== "POST") return fail(404, "not_found", "Not found.");

    if (env.PIXORA_ACCESS_KEY && req.headers.get("x-pixora-key") !== env.PIXORA_ACCESS_KEY) return fail(401, "unauthorized", "Access key missing or incorrect. Add it in Settings.");
    const ip = req.headers.get("CF-Connecting-IP") || "x", now = Date.now();
    const recent = (hits.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= (parseInt(env.RATE_LIMIT_PER_MIN) || 6)) return fail(429, "rate_limited", "Too many requests. Wait a minute and try again.");
    hits.set(ip, [...recent, now]);
    if (!env.HF_API_TOKEN || !env.HF_MODEL_ID) return fail(503, "not_configured", "The server has no Hugging Face token or model configured.");

    let form;
    try { form = await req.formData(); } catch { return fail(400, "upload_error", "The upload could not be read."); }
    const file = form.get("image");
    if (!file || typeof file === "string") return fail(400, "no_image", "Upload an image first.");
    if (file.size > maxMB * 1048576) return fail(413, "too_large", `Image exceeds the ${maxMB} MB limit.`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!MAGIC(bytes)) return fail(415, "bad_format", "Unsupported image. Use JPG, PNG or WEBP.");
    let prompt = String(form.get("prompt") || "").trim().slice(0, 1000);
    if (!prompt) return fail(400, "no_prompt", "Describe what should change.");
    let keep = []; try { keep = JSON.parse(form.get("preserve") || "[]"); } catch {}
    const list = keep.filter((k) => MAP[k]).map((k) => MAP[k]);
    if (list.length) prompt += `. Keep unchanged: ${list.join(", ")}. Change only what was requested.`;

    let bin = ""; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const fal = env.HF_PROVIDER === "fal-ai";
    const api = fal ? `https://router.huggingface.co/fal-ai/${env.HF_PROVIDER_MODEL || "fal-ai/qwen-image-edit"}`
      : (env.HF_API_URL || "https://router.huggingface.co/hf-inference/models/{model}").replace("{model}", env.HF_MODEL_ID);
    const payload = fal ? { image_url: `data:${MAGIC(bytes)};base64,${btoa(bin)}`, prompt } : { inputs: btoa(bin), parameters: { prompt } };
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), parseInt(env.TIMEOUT_MS) || 100000);
    try {
      const r = await fetch(api, { method: "POST", signal: ctl.signal,
        headers: { Authorization: `Bearer ${env.HF_API_TOKEN}`, "Content-Type": "application/json", Accept: "image/*" },
        body: JSON.stringify(payload) });
      const type = r.headers.get("content-type") || "";
      if (r.ok && type.startsWith("image/"))
        return new Response(r.body, { headers: { ...cors, "Content-Type": type, "X-Pixora-Model": env.HF_MODEL_ID, "Cache-Control": "no-store" } });
      if (fal && r.ok && type.includes("json")) { // provider returns JSON with a URL to the edited image
        const j = await r.json().catch(() => ({})), u = j?.images?.[0]?.url || j?.image?.url;
        if (!u) return fail(502, "invalid_response", "The provider replied without an image URL.");
        const ir = await fetch(u, { signal: ctl.signal }), it = ir.headers.get("content-type") || "";
        if (!ir.ok || !it.startsWith("image/")) return fail(502, "invalid_response", "The edited image could not be downloaded.");
        return new Response(ir.body, { headers: { ...cors, "Content-Type": it, "X-Pixora-Model": env.HF_MODEL_ID, "Cache-Control": "no-store" } });
      }
      let d = ""; try { const t = await r.text(); try { d = JSON.parse(t).error || t } catch { d = t } d = String(d).slice(0, 300); } catch {}
      if (r.ok) return fail(502, "invalid_response", "The model replied but did not return an image.");
      if (r.status === 401 || r.status === 403) return fail(502, "hf_auth", "Hugging Face rejected the server token.");
      if (r.status === 402) return fail(502, "quota", "Hugging Face credits or quota are used up.");
      if (r.status === 429) return fail(429, "hf_rate", "Hugging Face is rate limiting requests. Try again shortly.");
      if (r.status === 503) return fail(503, "model_loading", "The model is loading. Retry in about a minute.");
      if ([400, 404, 422].includes(r.status)) return fail(502, "unsupported_model", `The model or provider rejected this request (it may not support image editing). ${d}`);
      return fail(502, "generation_failed", `Image generation failed (${r.status}). ${d}`);
    } catch (e) {
      return e.name === "AbortError" ? fail(504, "timeout", "The model took too long to respond.") : fail(502, "network", "Could not reach Hugging Face.");
    } finally { clearTimeout(timer); }
  },
};
