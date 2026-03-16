# Clawser Browser Control

Chrome extension that gives the [Clawser](https://github.com/johnhenry/clawser) agent real browser control: tabs, screenshots, DOM interaction, input automation, and network monitoring.

## Install

**[Install from Chrome Web Store](https://chromewebstore.google.com/detail/clawser-browser-control/dljchbfodafekojicopaboiegophjcbc)**

## What It Does

- **Tab management** — create, close, navigate, and switch tabs
- **Screenshots** — capture visible tab content
- **DOM access** — read page structure, find elements, extract text
- **Input automation** — click, type, scroll, keyboard shortcuts
- **Form filling** — set values on input/select/textarea elements
- **Network monitoring** — read console logs and network requests
- **GIF recording** — record browser interactions as animated GIFs

## Architecture

- `background.js` — MV3 service worker handling tab orchestration, screenshots, and DevTools protocol
- `content.js` — content script injected into matching pages for DOM access
- `pod-inject.js` — web-accessible script that bridges the Clawser pod runtime with the extension
- `manifest.json` — Chrome MV3 manifest (minimum Chrome 135)
- `firefox/manifest.json` — Firefox-compatible manifest

## Development

Load as an unpacked extension:

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory

## Publishing

Releases are automated via GitHub Actions. Push a version tag to trigger a build, Chrome Web Store upload, and GitHub Release.

### First-time setup

You need Chrome Web Store API credentials. Get them from the [Chrome Web Store Developer Dashboard](https://developer.chrome.com/docs/webstore/using-api/):

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → create or select a project
2. Enable the **Chrome Web Store API**
3. Create an **OAuth 2.0 Client ID** (type: Desktop app)
4. Note the **Client ID** and **Client Secret**
5. Get a **Refresh Token** by running the OAuth consent flow — follow [Google's guide](https://developer.chrome.com/docs/webstore/using-api/#get-keys)

Then set the secrets on this repo:

```bash
gh secret set CWS_CLIENT_ID --repo johnhenry/clawser-browser-control --body "$CWS_CLIENT_ID"
gh secret set CWS_CLIENT_SECRET --repo johnhenry/clawser-browser-control --body "$CWS_CLIENT_SECRET"
gh secret set CWS_REFRESH_TOKEN --repo johnhenry/clawser-browser-control --body "$CWS_REFRESH_TOKEN"
```

### Releasing a new version

1. Bump the version in `manifest.json`
2. Commit and tag:

```bash
git add manifest.json
git commit -m "release: v0.1.1"
git tag v0.1.1
git push origin main --tags
```

3. GitHub Actions will:
   - Build a zip (excluding store assets, tests, etc.)
   - Upload to Chrome Web Store and publish
   - Create a GitHub Release with the zip attached

### Manual publishing

If you need to publish manually (e.g. first submission before CI secrets are set):

```bash
# Build the zip
zip -r clawser-browser-control.zip manifest.json background.js content.js pod-inject.js icons/ -x "*.DS_Store"

# Upload at https://chrome.google.com/webstore/devconsole
```

## Store Assets

The `store/` directory contains Chrome Web Store listing assets:
- Screenshots and promotional images
- Privacy policy
- Permission justifications

## License

MIT
