require("dotenv").config();
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const path = require("path");
const adapter = require("./models");

const { HF_API_TOKEN, HF_MODEL_ID, PIXORA_ACCESS_KEY } = process.env;
const API_URL = process.env.HF_API_URL || "https://router.huggingface.co/hf-inference/models/{model}";
const MAX = (parseFloat(process.env.MAX_UPLOAD_MB) || 8) * 1024 * 1024;
const TIMEOUT = parseInt(process.env.TIMEOUT_MS) || 120000;
const app = express();
app.disable("x-powered-by");
app.use((q, r, n) => { r.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" }); n(); });
app.get("/sw.js", (q, r) => r.set("Cache-Control", "no-cache").type("application/javascript").sendFile(path.join(__dirname, "public", "sw.js")));
app.use(express.static(path.join(__dirname, "public"), { setHeaders: (r, f) => { if (f.endsWith(".webmanifest")) r.type("application/manifest+json"); } }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX, files: 1 } });
const limiter = rateLimit({ windowMs: 60000, max: parseInt(process.env.RATE_LIMIT_PER_MIN) || 6, standardHeaders: true, legacyHeaders: false,
  handler: (q, r) => fail(r, 429, "rate_limited", "Too many requests. Wait a minute and try again.") });

const fail = (res, status, code, message) => res.status(status).json({ error: code, message });

// Verify real file contents (magic bytes), not just the declared MIME type.
function sniff(b) {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (b.length > 12 && b.slice(0, 4).toString() === "RIFF" && b.slice(8, 12).toString() === "WEBP") return "image/webp";
  return null;
}

app.get("/api/config", (q, r) => r.json({ maxUploadMB: MAX / 1048576, model: HF_MODEL_ID || null, configured: !!(HF_API_TOKEN && HF_MODEL_ID), requiresKey: !!PIXORA_ACCESS_KEY }));

app.post("/api/transform", limiter, (req, res, next) => {
  if (PIXORA_ACCESS_KEY && req.get("x-pixora-key") !== PIXORA_ACCESS_KEY) return fail(res, 401, "unauthorized", "Access key missing or incorrect. Add it in Settings.");
  next();
}, (req, res, next) => upload.single("image")(req, res, (e) => {
  if (e && e.code === "LIMIT_FILE_SIZE") return fail(res, 413, "too_large", `Image exceeds the ${MAX / 1048576} MB limit.`);
  if (e) return fail(res, 400, "upload_error", "The upload could not be read.");
  next();
}), async (req, res) => {
  if (!HF_API_TOKEN || !HF_MODEL_ID) return fail(res, 503, "not_configured", "The server has no Hugging Face token or model configured.");
  if (!req.file) return fail(res, 400, "no_image", "Upload an image first.");
  const mime = sniff(req.file.buffer);
  if (!mime) return fail(res, 415, "bad_format", "Unsupported image. Use JPG, PNG or WEBP.");
  let prompt = String(req.body.prompt || "").trim().slice(0, 1000);
  if (!prompt) return fail(res, 400, "no_prompt", "Describe what should change.");
  let keep = [];
  try { keep = JSON.parse(req.body.preserve || "[]"); } catch {}
  const map = { face: "the person's face", hair: "the hairstyle", body: "body proportions", background: "the original background", composition: "the image composition", lighting: "the original lighting", identity: "the person's identity" };
  const list = keep.filter((k) => map[k]).map((k) => map[k]);
  if (list.length) prompt += `. Keep unchanged: ${list.join(", ")}. Change only what was requested.`;

  const url = API_URL.replace("{model}", HF_MODEL_ID);
  const { headers, body } = adapter.buildRequest({ image: req.file.buffer, mime, prompt, token: HF_API_TOKEN });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { method: "POST", headers, body, signal: ctl.signal });
    const type = r.headers.get("content-type") || "";
    if (r.ok && type.startsWith("image/")) {
      const buf = Buffer.from(await r.arrayBuffer());
      res.set({ "Content-Type": type, "X-Pixora-Model": HF_MODEL_ID, "Cache-Control": "no-store" });
      return res.send(buf);
    }
    let detail = ""; try { const t = await r.text(); detail = (JSON.parse(t).error || t).toString().slice(0, 300); } catch {}
    if (r.ok) return fail(res, 502, "invalid_response", "The model replied but did not return an image.");
    if (r.status === 401 || r.status === 403) return fail(res, 502, "hf_auth", "Hugging Face rejected the server token.");
    if (r.status === 402) return fail(res, 502, "quota", "Hugging Face credits or quota are used up.");
    if (r.status === 429) return fail(res, 429, "hf_rate", "Hugging Face is rate limiting requests. Try again shortly.");
    if (r.status === 503) return fail(res, 503, "model_loading", "The model is loading. Retry in about a minute.");
    if (r.status === 404 || r.status === 400 || r.status === 422) return fail(res, 502, "unsupported_model", `The model or provider rejected this request (it may not support image editing). ${detail}`);
    return fail(res, 502, "generation_failed", `Image generation failed (${r.status}). ${detail}`);
  } catch (e) {
    if (e.name === "AbortError") return fail(res, 504, "timeout", "The model took too long to respond.");
    return fail(res, 502, "network", "Could not reach Hugging Face.");
  } finally { clearTimeout(timer); }
});

app.listen(process.env.PORT || 3000, () => console.log("PIXORA running on port " + (process.env.PORT || 3000)));
