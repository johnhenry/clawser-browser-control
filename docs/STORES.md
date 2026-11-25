# Submitting to the stores

What a person does, step by step, to list Clawser Browser Control on each store. An agent cannot do these: they need a store account, a payment or identity check, and a person's agreement to each store's terms. Everything the steps paste from is in `store/permission-justifications.txt` (permission justifications and listing copy) and `store/` (icons, screenshots, privacy policy).

Order, per the project default: **Chrome Web Store** (listing exists), then **Microsoft Edge Add-ons**, then **Firefox Add-ons**. The **Safari Web Extension** is last and needs a Mac (below).

Store rules change. Field names below are those of each dashboard as last documented; if one has moved, the intent is in the copy file.

## 0. Before any store: build and check the packages

```bash
npm ci && npm test                    # 600+ tests, including test/packaging.test.mjs (every permission has a justification)
node scripts/package.mjs --zip --out dist    # needs `zip`: dist/clawser-browser-control{,-edge,-firefox}.zip
```

- `clawser-browser-control.zip` goes to Chrome. `clawser-browser-control-edge.zip` is the same package for Edge. `clawser-browser-control-firefox.zip` goes to Firefox.
- Pushing a `v<version>` tag runs `.github/workflows/publish.yml`, which builds all three, uploads to the Chrome Web Store **and publishes it**, attaches the zips to a GitHub Release, and (once the Edge variables below are set) uploads to Edge. So **update the Chrome dashboard's permission text (step 1) before pushing the tag**, or the reviewed version carries the old blanket justifications.
- Bump `version` in `manifest.json` and `firefox/manifest.json` together (a test and CI check they agree with the tag).

### What is different about "per-site grants" for a reviewer

Since 0.6.0 the manifests declare `<all_urls>` only under `optional_host_permissions`, so the stores show no "all websites" install warning. `host_permissions` lists just the Clawser web app's own origins (`localhost`, `127.0.0.1`, `clawser.erisera.com`). When a person grants a site in the options page, the page calls `permissions.request({ origins: [origin] })` (from the click, as the browsers require) and revoking calls `permissions.remove`. On top of the browser's permission the extension keeps its own gate: a site works only if the person granted it AND the browser holds the permission for it, and tools are allowed by class (read, interact, sensitive) per site. The justification for the optional `<all_urls>` says exactly this. Reviewers may still ask why the optional pattern is declared: the "notes for the reviewer" block tells them how to see the gate working (pair, then grant, then approve the browser prompt).

Screenshots and GIF recording are the one thing that needs the blanket pattern: Chrome's `tabs.captureVisibleTab` works only with access to all sites (or `activeTab`, a per-click grant that cannot serve an agent). They are therefore a separate switch in the options page, off by default, that requests `<all_urls>` from the person's click; until it is on those tools refuse with `capture_not_enabled`. The justification says so.

Users updating from 0.5.0 keep their granted sites but must approve each in the browser again; the options page says so and has an Approve button per site. Mention it in the release notes.

`pod-inject.js` is not in any of the three store packages. `node scripts/package.mjs --with-pod-inject` builds a variant that has it; do not submit that one.

## 1. Chrome Web Store (the listing already exists)

Extension id `dljchbfodafekojicopaboiegophjcbc`. Dashboard: <https://chrome.google.com/webstore/devconsole>.

1. Open the item, then **Store listing**. Replace the **Detailed description** with "Detailed description (Chrome Web Store, Edge Add-ons)" from the copy file. Check **Category** and **Language**.
2. **Graphic assets**: icon `store/icon-128.png`, screenshots `store/screenshot-1280x800.png` and `-640x400.png`, small tile `promo-tile-440x280.png`, marquee `promo-marquee-1400x560.png`. The current screenshots show the old blanket model and a broken logo: **replace them** (see "Screenshots" below) before submitting 0.6.0.
3. **Privacy** tab:
   - **Single purpose**: paste "Single purpose description" (CHROME AND EDGE section).
   - **Permission justification**: one box per permission (`tabs`, `activeTab`, `scripting`, `userScripts`, `webRequest`, `cookies`, `storage`, `alarms`, `offscreen`, `sidePanel`, `contextMenus`, and the optional `debugger`), and **Host permission justification** for the five built-in Clawser origins and the optional `<all_urls>`: paste each block from the copy file. Delete a box for a permission the manifest no longer has.
   - **Remote code**: **No, I am not using remote code** (every script is packaged).
   - **Data usage**: tick none of the data types (nothing is sent to a server) and certify the three statements.
   - **Privacy policy URL**: `https://github.com/johnhenry/clawser-browser-control/blob/main/store/privacy-policy.md`.
4. Save the draft. Then push the tag (`git tag v0.6.0 && git push origin v0.6.0`): the workflow uploads and submits the package. Review typically takes days; an optional host permission does not add the in-depth review notice a required `<all_urls>` can.
5. Optional: if the listing was created before `CWS_PUBLISHER_ID` (repository variable) and `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN` (repository secrets) were set, they must still be valid; the upload step fails loudly if not.

## 2. Microsoft Edge Add-ons

Dashboard: <https://partner.microsoft.com/dashboard/microsoftedge/overview>. Edge runs Chrome MV3 extensions, so the package is the Chrome one (`clawser-browser-control-edge.zip`).

1. **Account.** Sign in with a Microsoft account and register as an Edge extension developer (free; it asks for contact and publisher details).
2. **Create the extension.** **Create new extension**, upload `dist/clawser-browser-control-edge.zip`. Wait for the package check to pass.
3. **Availability.** Public, all markets, or choose markets. Visibility: public (or hidden while testing).
4. **Properties.** Category (Developer tools or Productivity), **Privacy policy URL** (as above), **Website** (`https://github.com/johnhenry/clawser-browser-control`), **Support contact**. Answer "does your extension access personal data" with no collection, matching the privacy policy.
5. **Store listings (English).** Name, **Description** (Chrome/Edge description from the copy file), **Short description** (the SHORT DESCRIPTION line), **Extension logo** `store/icon-300.png` (300x300), screenshots (1280x800 or 640x400), optional small promo tile 440x280 and large tile 1400x560.
6. **Notes for certification.** Paste the "Notes for the reviewer" block (they need the Clawser web app to see anything).
7. **Publish.** Edge does not have a separate permission-justification form; the notes and description carry it.
8. **Automatic uploads (optional).** In Partner Center open the extension, then **Publish API**, **Enable**, **Create API credentials**; note the **Client ID** and **API key** (the key **expires after 72 days** and must be renewed) and the extension's **Product ID** (a GUID from the extension overview). In the GitHub repository set variable `EDGE_PRODUCT_ID` and secrets `EDGE_CLIENT_ID`, `EDGE_API_KEY`. The publish workflow's Edge step then runs on every tag. That step has not been run against the live API; the first tagged release after setup is its test, and a failure there does not undo the Chrome upload (check the Actions log; the zip is also on the GitHub Release, so a manual upload in step 2 always works).

## 3. Firefox Add-ons (AMO)

Dashboard: <https://addons.mozilla.org/developers/>. The package is `clawser-browser-control-firefox.zip`.

1. **Account.** Create or sign in to a Firefox Account, then **Submit a New Add-on**.
2. **Distribution.** **On this site** (listed). Accept the Distribution Agreement.
3. **Upload** `dist/clawser-browser-control-firefox.zip`. The validator should pass. A warning about `userScripts` is expected, and one about the optional `<all_urls>` may appear; the reviewer notes explain them. The manifest already declares `data_collection_permissions: required: ["none"]` (what AMO now asks every new add-on).
4. **Source code.** The package has no generated or minified file (`pod-inject.js`, the one generated bundle, is not in the default build), so AMO should not ask for source. If it does, answer **Yes** and upload `git archive --format=zip -o dist/source.zip HEAD`; in the "build" notes say that everything shipped is unminified source and `node scripts/package.mjs firefox` stages the package (manifest from `firefox/manifest.json`).
5. **Listing.** Name, **Summary** (the FIREFOX SUMMARY line, 250 characters at most), **Description** (the Firefox description), category (Other), support site and email, **License** MIT, **Privacy policy** (paste the policy text or link it), screenshots.
6. **Notes to reviewer.** Paste "Notes for the reviewer". Say that there is no side panel and that the options page is the add-on's Preferences in `about:addons`.
7. **Submit.** Listed add-ons are reviewed by a person; expect some days. After approval Mozilla signs it; users install from the listing.
8. **Automatic uploads: not done.** `web-ext sign` only signs unlisted add-ons, and the listed-version upload API needs JWT credentials (AMO API key and secret, under **Tools**, **Manage API Keys**). Until a person creates them and decides to automate it, each release is one manual upload of the zip from the GitHub Release.

Self-distribution without AMO review is possible (an unlisted signed build) but is not offered.

## 4. Safari Web Extension: needs a person

Not built. It needs a Mac with Xcode, an Apple Developer Program membership (paid, yearly) and App Store Connect, none of which an agent has. The outline:

1. On a Mac: `xcrun safari-web-extension-converter <staged firefox or chrome build> --app-name "Clawser Browser Control" --bundle-identifier <your.reverse.domain>`, then open the generated Xcode project.
2. Expect to remove or replace what Safari lacks: `userScripts`, `offscreen`, `sidePanel`, and the `webRequest` observation used for network monitoring; the browser test has not been run on Safari at all.
3. Sign with the developer team, test with "Allow unsigned extensions" in Safari's Develop menu, archive, and submit through App Store Connect (Safari extensions ship inside an app). Reviewers will ask for the same per-site explanation.

Decision needed from the owner first: who owns the Apple account, and whether a Safari build is wanted before the Chromium and Firefox ones are stable.

## Screenshots

The existing images in `store/` come from the first release and show the blanket model. Take new ones that show the per-site grants (the options page's "Granted sites" list with the class boxes), at 1280x800. A browser test run on Chromium with `VIAFRAME_EXT_BROWSER=chromium` opens that page; or load the unpacked extension (`chrome://extensions`, Developer mode, Load unpacked), pair a page, grant a site, and screenshot the options page.

## Checklist of what only a person can finish

| Store | Done by an agent | Left for a person |
| --- | --- | --- |
| Chrome Web Store | package, copy, justifications, upload workflow | paste the justifications and replace screenshots in the dashboard, then push the tag |
| Edge Add-ons | package, copy, 300x300 logo, optional upload step | create the account and the listing, submit, optional API credentials |
| Firefox Add-ons | package, copy, manifest data-collection declaration, source-zip recipe | create the account, submit, answer the review |
| Safari | nothing | everything (Mac, Xcode, Apple account) |
