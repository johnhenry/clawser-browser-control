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

Releases are automated via GitHub Actions. Push a version tag to trigger:

```bash
git tag v0.1.1
git push origin main --tags
```

The CI workflow builds a zip, uploads to Chrome Web Store, and publishes.

## Store Assets

The `store/` directory contains Chrome Web Store listing assets:
- Screenshots and promotional images
- Privacy policy
- Permission justifications

## License

MIT
