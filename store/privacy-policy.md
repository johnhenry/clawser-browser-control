# Clawser Browser Control — Privacy Policy

**Last updated:** March 13, 2026

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

All accessed data is processed locally and communicated only to the Clawser workspace running on your local machine (localhost).

## Storage

The extension uses `chrome.storage.local` to persist configuration settings. No personal data is stored.

## Communication

The extension communicates exclusively with the Clawser workspace via local messaging (content scripts on localhost/127.0.0.1 origins). It does not make any external network requests of its own.

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
| `debugger` (optional) | Advanced browser inspection when enabled by user |
| `<all_urls>` (host) | Operate on any page the user directs the agent to |

## Changes

We may update this policy from time to time. Changes will be reflected in the "Last updated" date above.

## Contact

For questions about this privacy policy, open an issue at the project's GitHub repository or contact john@iamjohnhenry.com.
