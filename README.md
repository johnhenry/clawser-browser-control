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
- **WebMCP in other tabs** — list and call the tools a page registers on `document.modelContext`, so the Clawser agent can use what other open tabs offer (`webmcp_list_tools`, `webmcp_call_tool`; see below)

## Architecture

- `background.js` — MV3 service worker handling tab orchestration, screenshots, input simulation, and the routine scheduler
- `content.js` — content script injected into matching pages, relaying page <-> extension RPC
- `pod-inject.js` — web-accessible script, injected into the page's MAIN world via `chrome.scripting.executeScript`, that boots an `InjectedPod` for page-side text/structured-data extraction, a visual overlay indicator, and BroadcastChannel peer discovery. It relays page-originated Pod messages up to the extension via `InjectedPod`'s `extensionBridge` constructor option: the boot wrapper (defined in `scripts/build-pod-inject.mjs`'s `BOOT_SECTION`, not the bundled npm package source) constructs a bridge whose `postMessage()` reuses `content.js`'s existing page → background `notify` relay (`window.postMessage({ type: '__clawser_ext__', direction: 'notify', action: 'pod_message', params: { msg } }, '*')`), which `content.js` forwards to `background.js` after checking its own origin allowlist. Generated from the `browsermesh-pod`/`browsermesh-primitives` npm packages by `scripts/build-pod-inject.mjs` (`npm run build:pod-inject`) — do not edit directly; bump the pinned versions in `package.json` and regenerate instead.
- WebMCP tab tools (`background.js`: `actionWebmcpListTools` / `actionWebmcpCallTool`) — there is deliberately **no content script on arbitrary pages**. When Clawser asks, the service worker injects a small function into the MAIN world of the requested tab(s) (`chrome.scripting.executeScript`, the same mechanism as `webmcp_discover`) that reads `document.modelContext.getTools()` or runs `executeTool(tool, jsonString)` (also `navigator.modelContextTesting` for older Chrome previews). Listing covers every open http(s) tab (capped at 50, 100 tools each). Calling requires the `expectedOrigin` the tool was listed on and refuses if the tab has since navigated elsewhere; arguments, results, descriptions and schemas are size-clamped; a page's `readOnlyHint` is dropped (only `destructiveHint` is forwarded) because a page's claim about itself is not evidence; each call is written to the audit log (tool name and origin only, never arguments or results). Capability name: `webmcp_tabs`. Approval of each call is Clawser's job (mcp-gate policy and its approval dialog), not the extension's.
- `sidepanel.html` / `sidepanel.js` / `sidepanel.css` — browser-tasks side panel (Chrome). Four entry actions (Compare tabs, Extract data, Watch page and Create workflow; the last two say "Coming in a later release"), an explicit tab picker, and the shared task list, inbox and last-run status. The list and inbox are read from a connected Clawser tab with `{type:"clawser.btask.list"}` / `{type:"clawser.btask.inbox"}`; with no Clawser tab connected it says "Open clawser to see your tasks" and shows nothing else. It never runs a task: it hands Clawser a `clawser.btask.draft` message, which Clawser shows as a draft for the user to confirm.
- Context menus (`background.js`) — "Extract data from this section", "Compare with other tabs", "Watch this section". For a section, the service worker runs a small function in the clicked page (on demand, via `chrome.scripting`, top frame only) that returns a short unique selector and a text hint of at most 120 characters (never form-field values). The result is treated as untrusted and re-validated before it is sent.
- `options.html` / `options.js` — options page for the one extra Clawser origin (see below).
- `gifenc.js` — vendored GIF encoder (see THIRD-PARTY-LICENSES.md), used for GIF recording
- `offscreen.html` / `offscreen.js` — Chrome-only offscreen document that decodes captured frames and encodes them into a GIF (a service worker has no DOM/canvas to do this itself); Firefox's MV3 background page keeps DOM access, so it encodes inline instead
- `manifest.json` — Chrome MV3 manifest (minimum Chrome 135)
- `firefox/manifest.json` — Firefox MV3 manifest (minimum Firefox 128)

## Permissions

Beyond the permissions used for browser control (`tabs`, `activeTab`, `scripting`, `userScripts`, `webRequest`, `cookies`, `storage`, `alarms`, `offscreen`, host access), the browser-tasks feature adds two:

- `sidePanel` — shows the browser-tasks panel (launcher, task list, inbox, last run) next to the page. The toolbar button opens it.
- `contextMenus` — adds the three right-click entries that start a draft from the page or section you clicked.

Neither grants access to page content by itself. Nothing is read from a page except when you choose a context-menu entry or send a draft, and a draft is only a message to your Clawser tab: Clawser shows it and nothing runs until you confirm there.

### Clawser origin

The content script (the bridge between Clawser and the extension) runs only on `http(s)://localhost`, `http(s)://127.0.0.1`, `file://` and `https://clawser.erisera.com`. If you host Clawser elsewhere, set one additional **https origin** on the extension's options page. It must be a plain origin (no path, wildcard, credentials or IP address). The service worker validates it, stores it in `chrome.storage.local`, and registers `content.js` for exactly that origin; `content.js` re-checks `location.origin` itself before relaying anything. Only extension pages (the options page and the side panel) can change it; a web page cannot.

## Development

Load as an unpacked extension:

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory

### Tests

```
npm test
```

`background.js` and `content.js` are plain (non-module) scripts with no build
step, so `test/_load-background.mjs` and `test/_load-content.mjs` load the
real, unmodified source into an isolated `node:vm` context with a stubbed
`chrome` API per test — no browser or headless runner required. This is test
tooling only; the shipped extension has no runtime dependencies.

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

1. Bump the version in **both** `manifest.json` and `firefox/manifest.json` — keep them in sync
2. Commit and tag:

```bash
git add manifest.json firefox/manifest.json
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
# Build the zip (file list shared with CI/publish workflows)
zip -r clawser-browser-control.zip -@ -x "*.DS_Store" < scripts/dist-files.txt

# Upload at https://chrome.google.com/webstore/devconsole
```

## Store Assets

The `store/` directory contains Chrome Web Store listing assets:
- Screenshots and promotional images
- Privacy policy
- Permission justifications

## License

MIT
