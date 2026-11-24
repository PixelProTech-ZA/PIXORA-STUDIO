# PIXORA: Images. Reimagined.

PixelProTech Solutions (Pty) Ltd. Upload a photo, describe the change, and AI edits it.

## How it works
- **Website:** static files on GitHub Pages (this folder, flat, no subfolders).
- **API:** a Cloudflare Worker (`worker.js`, `wrangler.toml`) holds the Magic Hour API key and calls Magic Hour. The key never reaches the browser.
- `config.js` tells the website where the Worker lives (`window.PIXORA_API`).

## Deploy the Worker
1. `npx wrangler login`
2. `npx wrangler deploy`
3. `npx wrangler secret put MAGIC_HOUR_API_KEY`
4. Optional, stops strangers using your credits: `npx wrangler secret put PIXORA_ACCESS_KEY`. Users enter it in Settings → Access Key.
5. Built-in app key (so installed apps need no typing): `npx wrangler secret put PIXORA_APP_KEY` and use the same value for `window.PIXORA_APP_KEY` in `config.js`. It is public, so keep `RATE_LIMIT_PER_MIN` low and rotate it if abused. Your private `PIXORA_ACCESS_KEY` still works for you and is never put in the repo.
6. Put the Worker address in `config.js`, commit, push.

Check it: open `<worker address>/api/config`. You should see `"configured":true`.

## Settings (`wrangler.toml`)
`ALLOWED_ORIGIN` (the website origin, comma-separate to add localhost), `MAGIC_HOUR_MODEL`, `MAX_UPLOAD_MB`, `RATE_LIMIT_PER_MIN`, `TIMEOUT_MS`.

## Privacy
Photos are sent through the Worker to Magic Hour for processing. The Worker stores nothing. Creations are kept only in the user's browser.

## PWA
Installable on Android and iOS. Only the app shell is cached; photos and API calls never are. Bump `V` in `sw.js` whenever you change any file.

## Flat folder rule
Every file sits side by side. No subfolders.

Brand colours: background #040C0C, teal #00D4AA, violet #7B2FFF. Edit the `:root` variables in `index.html`.
