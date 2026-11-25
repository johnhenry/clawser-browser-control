# Clawser Browser Control — Privacy Policy

**Last updated:** November 25, 2026 (version 0.6.0)

## Overview

Clawser Browser Control is a browser extension that enables the Clawser agent workspace to interact with your browser. This policy explains what data the extension accesses and how it is handled.

## Data Collection

**Clawser Browser Control does not collect, transmit, or store any personal data on external servers.** All data stays on your local machine.

The extension does not:
- Send any data to third-party servers
- Track browsing activity or history
- Use analytics or telemetry services
- Store cookies for tracking purposes
- Share any information with third parties

## Data Access

The extension requires browser permissions to provide its functionality. When activated by the local Clawser agent workspace, it may access:

- **Tab information** (URLs, titles) — to navigate and manage tabs on your behalf
- **Page content (DOM)** — to read and interact with web page elements
- **Screenshots and GIF recordings** — to capture visible page content for the agent, only after you turn on the separate "Screenshots and GIFs" switch in the options page (off by default; turning it on asks the browser for access to all sites, because the browser's capture API needs it)
- **Cookies** — to relay authentication state to the agent when requested
- **Network requests** — to monitor page network activity when requested
- **Browser-task drafts** — when you use the side panel or a right-click entry, the page title, URL, and (for a section) a selector and a short text hint of at most 120 characters are sent to your own Clawser tab as a draft. Nothing runs until you confirm it in Clawser
- **WebMCP tools** — the names, descriptions and schemas of tools a web page registers on `document.modelContext`, and the result of a tool call, only when the local Clawser workspace asks for them

All accessed data is processed locally and communicated only to the Clawser workspace running on your local machine (localhost).

## Storage

The extension uses `chrome.storage.local` to persist configuration settings. No personal data is stored.

## Communication

The extension communicates exclusively with the Clawser workspace via local messaging (content scripts on localhost/127.0.0.1 origins, `https://clawser.erisera.com`, and one https origin you may add on the options page). It does not make any external network requests of its own.

## Permissions Justification

The extension can only work on a site you have granted, by exact origin, in its own options page. A new grant allows "read" tools only; "interact" and "sensitive" tools are separate choices per site. Every other call is refused. The full text of each justification is in `store/permission-justifications.txt`.

| Permission | Purpose |
|---|---|
| `tabs` | List, open, navigate and close tabs; a tab is listed only for a granted site, by origin |
| `activeTab` | Work on the tab you are looking at when you use the menu or side panel |
| `scripting` | Run the extension's own packaged reader and input code in a granted tab (read, interact classes) |
| `userScripts` | Run a script you wrote in Clawser, only after you switch it on for that page |
| `webRequest` | Observe request metadata (no credentials, query values, headers or bodies) on a granted tab that allows the sensitive class |
| `cookies` | Off by default; only when you switch it on for one paired page |
| `storage` | Keep settings, paired origins, granted sites and the audit log on this machine |
| `alarms` | Check once a minute whether a Clawser routine is due |
| `offscreen` | Encode a GIF you asked to record (Chrome and Edge) |
| `sidePanel` | Show the browser-tasks panel (Chrome and Edge) |
| `contextMenus` | Add right-click entries that start a browser-task draft |
| `debugger` (optional) | Not used in this version |
| Host permissions | Only the pairing origins (localhost, 127.0.0.1, `https://clawser.erisera.com`) are declared up front |
| `<all_urls>` (optional host) | Not granted at install. When you grant a site in the options page, the browser asks you for that one origin, and revoking the site gives it back. Only the "Screenshots and GIFs" switch asks for all sites, with its own prompt |

## Changes

We may update this policy from time to time. Changes will be reflected in the "Last updated" date above.

## Contact

For questions about this privacy policy, open an issue at the project's GitHub repository or contact john@iamjohnhenry.com.
