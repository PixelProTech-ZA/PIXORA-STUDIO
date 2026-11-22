# PIXORA — Images. Reimagined.
1. `npm install`
2. `cp .env.example .env` and set `HF_API_TOKEN` and `HF_MODEL_ID` (an image-editing model/provider that accepts an image plus an instruction and returns an image).
3. `npm start`, open http://localhost:3000

Notes
- The token stays on the server. The browser only talks to `/api/transform`.
- The server keeps no images and logs no image data. Creations are stored in the user's own browser (IndexedDB); originals only if the user opts in.
- Hosted inference APIs differ in request format. If your model expects another shape, edit `models.js` (the adapter) or `HF_API_URL`.
- Deploy behind HTTPS and set `PIXORA_ACCESS_KEY` to stop strangers using your quota.

Brand colours (from the PixelProTech corporate profile): background #07070A, surfaces #1A1A22, teal #00D4AA (primary accent), violet #7B2FFF (secondary), text #F1EEFA / #9A90B8. Edit the `:root` variables in `public/index.html` to change them.

## PWA
- Installable on Android (Chrome: menu → Install app, or the in-app Install button). Needs HTTPS in production (localhost works for testing).
- Caches only the app shell. Photos and `/api` calls are never cached; transforming needs a connection.
- Mobile layout: bottom navigation, sticky TRANSFORM IMAGE button, Take a photo (camera), safe-area support.
- Bump `V` in `public/sw.js` when you ship UI changes so installed apps refresh.
