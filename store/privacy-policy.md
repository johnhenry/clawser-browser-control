# Clawser Browser Control — Privacy Policy

**Last updated:** October 8, 2026

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
- **Screenshots** — to capture visible page content for the agent
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

| Permission | Purpose |
|---|---|
| `tabs` | Open, close, navigate, and query browser tabs |
| `activeTab` | Access the currently active tab when invoked |
| `scripting` | Inject content scripts to read/modify page DOM |
| `userScripts` | Execute user-defined scripts in page context |
| `webRequest` | Monitor network requests for debugging |
| `cookies` | Read cookies for authentication relay |
| `storage` | Persist extension configuration locally |
| `alarms` | Schedule periodic tasks (e.g., heartbeat) |
| `sidePanel` | Show the browser-tasks panel (launchers, tab picker, task list, inbox) |
| `contextMenus` | Add right-click entries that start a browser-task draft from the clicked section |
| `debugger` (optional) | Advanced browser inspection when enabled by user |
| `<all_urls>` (host) | Operate on any page the user directs the agent to |

## Changes

We may update this policy from time to time. Changes will be reflected in the "Last updated" date above.

## Contact

For questions about this privacy policy, open an issue at the project's GitHub repository or contact john@iamjohnhenry.com.
