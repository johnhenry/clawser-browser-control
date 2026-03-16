// pod-inject.js — Auto-generated IIFE bundle for Chrome extension injection.
// Do not edit directly. Regenerate with: bash web/packages/pod/build.sh
(function() {
'use strict';
if (globalThis[Symbol.for('pod.runtime')]) return;

// ── mesh-primitives/identity.mjs ──
/**
 * Encode a Uint8Array as a base64url string (no padding).
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function encodeBase64url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode a base64url string (no padding) to a Uint8Array.
 *
 * @param {string} str
 * @returns {Uint8Array}
 */
function decodeBase64url(str) {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const binary = atob(s);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Derive a pod ID from an Ed25519 public key.
 * Pod ID = base64url(SHA-256(raw public key bytes)).
 *
 * @param {CryptoKey} publicKey - Ed25519 public key
 * @returns {Promise<string>} Base64url-encoded pod ID
 */
async function derivePodId(publicKey) {
  const raw = await crypto.subtle.exportKey('raw', publicKey);
  const hash = await crypto.subtle.digest('SHA-256', raw);
  return encodeBase64url(new Uint8Array(hash));
}

/**
 * Represents a BrowserMesh pod identity (Ed25519 key pair).
 *
 * @class
 */
class PodIdentity {
  /**
   * @param {object} opts
   * @param {CryptoKeyPair} opts.keyPair - Ed25519 key pair
   * @param {string} opts.podId - Base64url-encoded public key hash
   */
  constructor({ keyPair, podId }) {
    /** @type {CryptoKeyPair} */
    this.keyPair = keyPair;
    /** @type {string} */
    this.podId = podId;
  }

  /**
   * Generate a new PodIdentity with a fresh Ed25519 key pair.
   *
   * @returns {Promise<PodIdentity>}
   */
  static async generate() {
    const keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true, // extractable
      ['sign', 'verify']
    );
    const podId = await derivePodId(keyPair.publicKey);
    return new PodIdentity({ keyPair, podId });
  }

  /**
   * Sign data with this identity's private key.
   *
   * @param {BufferSource} data - Data to sign
   * @returns {Promise<Uint8Array>} Ed25519 signature
   */
  async sign(data) {
    return new Uint8Array(
      await crypto.subtle.sign('Ed25519', this.keyPair.privateKey, data)
    );
  }

  /**
   * Verify a signature against a public key.
   *
   * @param {CryptoKey} publicKey - Ed25519 public key
   * @param {BufferSource} data - Original data
   * @param {BufferSource} signature - Signature to verify
   * @returns {Promise<boolean>}
   */
  static async verify(publicKey, data, signature) {
    return crypto.subtle.verify('Ed25519', publicKey, signature, data);
  }
}

// ── pod/detect-kind.mjs ──
/**
 * detect-kind.mjs — Classify the current execution context.
 *
 * Inspects globalThis to determine what kind of browser (or non-browser)
 * environment this code is running in. Returns one of 8 pod kinds.
 */

/** @typedef {'service-worker'|'shared-worker'|'worker'|'worklet'|'server'|'iframe'|'spawned'|'window'} PodKind */

/**
 * Detect the pod kind for the current execution context.
 *
 * @param {object} [g=globalThis] - The global scope to inspect
 * @returns {PodKind}
 */
function detectPodKind(g = globalThis) {
  // Service worker (extends WorkerGlobalScope, check first)
  if (typeof g.ServiceWorkerGlobalScope !== 'undefined' && g instanceof g.ServiceWorkerGlobalScope) {
    return 'service-worker'
  }

  // Shared worker
  if (typeof g.SharedWorkerGlobalScope !== 'undefined' && g instanceof g.SharedWorkerGlobalScope) {
    return 'shared-worker'
  }

  // Dedicated worker (generic WorkerGlobalScope — after SW/SharedWorker checks)
  if (typeof g.WorkerGlobalScope !== 'undefined' && g instanceof g.WorkerGlobalScope) {
    return 'worker'
  }

  // Audio worklet
  if (typeof g.AudioWorkletGlobalScope !== 'undefined' && g instanceof g.AudioWorkletGlobalScope) {
    return 'worklet'
  }

  // No window or document → server / Node.js / Deno
  if (typeof g.window === 'undefined' || typeof g.document === 'undefined') {
    return 'server'
  }

  // Window exists — check framing
  try {
    if (g.window !== g.window.parent) return 'iframe'
  } catch {
    // Cross-origin parent access throws — must be an iframe
    return 'iframe'
  }

  // Spawned window (window.open)
  if (g.window.opener) return 'spawned'

  // Default: top-level window
  return 'window'
}

// ── pod/capabilities.mjs ──
/**
 * capabilities.mjs — Detect available browser/runtime capabilities.
 *
 * Returns a PodCapabilities object describing what messaging, network,
 * storage, and compute primitives are available in the current context.
 */

/**
 * @typedef {object} PodCapabilities
 * @property {object} messaging
 * @property {boolean} messaging.postMessage
 * @property {boolean} messaging.messageChannel
 * @property {boolean} messaging.broadcastChannel
 * @property {boolean} messaging.sharedWorker
 * @property {boolean} messaging.serviceWorker
 * @property {object} network
 * @property {boolean} network.fetch
 * @property {boolean} network.webSocket
 * @property {boolean} network.webTransport
 * @property {boolean} network.webRTC
 * @property {object} storage
 * @property {boolean} storage.indexedDB
 * @property {boolean} storage.cacheAPI
 * @property {boolean} storage.opfs
 * @property {object} compute
 * @property {boolean} compute.wasm
 * @property {boolean} compute.sharedArrayBuffer
 * @property {boolean} compute.offscreenCanvas
 */

/**
 * Detect capabilities available in the current execution context.
 *
 * @param {object} [g=globalThis] - The global scope to inspect
 * @returns {PodCapabilities}
 */
function detectCapabilities(g = globalThis) {
  return {
    messaging: {
      postMessage: typeof g.postMessage === 'function',
      messageChannel: typeof g.MessageChannel === 'function',
      broadcastChannel: typeof g.BroadcastChannel === 'function',
      sharedWorker: typeof g.SharedWorker === 'function',
      serviceWorker: !!(g.navigator && g.navigator.serviceWorker),
    },
    network: {
      fetch: typeof g.fetch === 'function',
      webSocket: typeof g.WebSocket === 'function',
      webTransport: typeof g.WebTransport === 'function',
      webRTC: typeof g.RTCPeerConnection === 'function',
    },
    storage: {
      indexedDB: typeof g.indexedDB !== 'undefined',
      cacheAPI: typeof g.caches !== 'undefined',
      opfs: !!(g.navigator && g.navigator.storage && typeof g.navigator.storage.getDirectory === 'function'),
    },
    compute: {
      wasm: typeof g.WebAssembly !== 'undefined',
      sharedArrayBuffer: typeof g.SharedArrayBuffer === 'function',
      offscreenCanvas: typeof g.OffscreenCanvas === 'function',
    },
  }
}

// ── pod/messages.mjs ──
/**
 * messages.mjs — Pod wire protocol message types and factories.
 *
 * Defines the message constants and factory functions used for pod
 * discovery, handshake, and inter-pod communication.
 */

// ── Message type constants ──────────────────────────────────────

const POD_HELLO = 'pod:hello'
const POD_HELLO_ACK = 'pod:hello-ack'
const POD_GOODBYE = 'pod:goodbye'
const POD_MESSAGE = 'pod:message'
const POD_RPC_REQUEST = 'pod:rpc-request'
const POD_RPC_RESPONSE = 'pod:rpc-response'

// ── Message factories ───────────────────────────────────────────

/**
 * Create a HELLO message for discovery / parent handshake.
 *
 * @param {object} opts
 * @param {string} opts.podId - Sender's pod ID
 * @param {string} opts.kind - Sender's pod kind
 * @param {object} [opts.capabilities] - Sender's capabilities snapshot
 * @returns {object}
 */
function createHello({ podId, kind, capabilities }) {
  return {
    type: POD_HELLO,
    podId,
    kind,
    capabilities: capabilities || null,
    ts: Date.now(),
  }
}

/**
 * Create a HELLO_ACK response.
 *
 * @param {object} opts
 * @param {string} opts.podId - Responder's pod ID
 * @param {string} opts.kind - Responder's pod kind
 * @param {string} opts.targetPodId - Original sender's pod ID
 * @returns {object}
 */
function createHelloAck({ podId, kind, targetPodId }) {
  return {
    type: POD_HELLO_ACK,
    podId,
    kind,
    targetPodId,
    ts: Date.now(),
  }
}

/**
 * Create a GOODBYE message (graceful shutdown announcement).
 *
 * @param {object} opts
 * @param {string} opts.podId - Departing pod's ID
 * @returns {object}
 */
function createGoodbye({ podId }) {
  return {
    type: POD_GOODBYE,
    podId,
    ts: Date.now(),
  }
}

/**
 * Create a generic inter-pod message.
 *
 * @param {object} opts
 * @param {string} opts.from - Sender pod ID
 * @param {string} opts.to - Target pod ID (or '*' for broadcast)
 * @param {*} opts.payload - Message payload
 * @returns {object}
 */
function createMessage({ from, to, payload }) {
  return {
    type: POD_MESSAGE,
    from,
    to,
    payload,
    ts: Date.now(),
  }
}

/**
 * Create an RPC request message.
 *
 * @param {object} opts
 * @param {string} opts.from - Sender pod ID
 * @param {string} opts.to - Target pod ID
 * @param {string} opts.method - RPC method name
 * @param {*} [opts.params] - Method parameters
 * @param {string} opts.requestId - Unique request identifier
 * @returns {object}
 */
function createRpcRequest({ from, to, method, params, requestId }) {
  return {
    type: POD_RPC_REQUEST,
    from,
    to,
    method,
    params: params ?? null,
    requestId,
    ts: Date.now(),
  }
}

/**
 * Create an RPC response message.
 *
 * @param {object} opts
 * @param {string} opts.from - Responder pod ID
 * @param {string} opts.to - Original requester pod ID
 * @param {string} opts.requestId - Matching request identifier
 * @param {*} [opts.result] - Success result
 * @param {string} [opts.error] - Error message if failed
 * @returns {object}
 */
function createRpcResponse({ from, to, requestId, result, error }) {
  return {
    type: POD_RPC_RESPONSE,
    from,
    to,
    requestId,
    result: result ?? null,
    error: error ?? null,
    ts: Date.now(),
  }
}

// ── pod/pod.mjs ──
/**
 * pod.mjs — Pod base class.
 *
 * A Pod is any browser execution context that can execute code, receive
 * messages, and be discovered/addressed. This base class implements the
 * 6-phase BrowserMesh boot sequence: Install Runtime → Install Listeners →
 * Self-Classification → Parent Handshake → Peer Discovery → Role Finalization.
 *
 * Zero Clawser imports — depends only on mesh-primitives for identity.
 */

  POD_HELLO, POD_HELLO_ACK, POD_GOODBYE, POD_MESSAGE,
  POD_RPC_REQUEST, POD_RPC_RESPONSE,
  createHello, createHelloAck, createGoodbye, createMessage,
} from './messages.mjs'

const POD_RUNTIME_KEY = Symbol.for('pod.runtime')
const DEFAULT_HANDSHAKE_TIMEOUT = 1000
const DEFAULT_DISCOVERY_TIMEOUT = 2000
const DEFAULT_DISCOVERY_CHANNEL = 'pod-discovery'

/** @typedef {'idle'|'booting'|'ready'|'shutdown'} PodState */
/** @typedef {'autonomous'|'child'|'peer'|'controlled'|'hybrid'} PodRole */

class Pod {
  #identity = null
  #kind = null
  #capabilities = null
  #role = 'autonomous'
  #state = 'idle'
  #peers = new Map()
  #listeners = new Map()
  #discoveryChannel = null
  #messageHandler = null
  #g = null

  // ── Getters ──────────────────────────────────────────────────

  /** @returns {string|null} */
  get podId() { return this.#identity?.podId ?? null }

  /** @returns {PodIdentity|null} */
  get identity() { return this.#identity }

  /** @returns {import('./capabilities.mjs').PodCapabilities|null} */
  get capabilities() { return this.#capabilities }

  /** @returns {import('./detect-kind.mjs').PodKind|null} */
  get kind() { return this.#kind }

  /** @returns {PodRole} */
  get role() { return this.#role }

  /** @returns {PodState} */
  get state() { return this.#state }

  /** @returns {Map<string, object>} podId → peer info */
  get peers() { return new Map(this.#peers) }

  // ── Boot ─────────────────────────────────────────────────────

  /**
   * Run the 6-phase boot sequence.
   *
   * @param {object} [opts]
   * @param {PodIdentity} [opts.identity] - Pre-existing identity (skips generation)
   * @param {string} [opts.discoveryChannel] - BroadcastChannel name
   * @param {number} [opts.handshakeTimeout] - ms to wait for parent ACK
   * @param {number} [opts.discoveryTimeout] - ms to wait for peer responses
   * @param {object} [opts.globalThis] - Override globalThis for testing
   */
  async boot(opts = {}) {
    if (this.#state !== 'idle') {
      throw new Error(`Pod already in state: ${this.#state}`)
    }
    this.#state = 'booting'
    this.#g = opts.globalThis || globalThis

    try {
      // Phase 0: Install Runtime
      this.#emit('phase', { phase: 0, name: 'install-runtime' })
      this.#identity = opts.identity || await PodIdentity.generate()
      this.#kind = detectPodKind(this.#g)
      this.#capabilities = detectCapabilities(this.#g)
      this.#g[POD_RUNTIME_KEY] = {
        podId: this.podId,
        kind: this.#kind,
        capabilities: this.#capabilities,
        pod: this,
      }

      // Phase 1: Install Listeners
      this.#emit('phase', { phase: 1, name: 'install-listeners' })
      this.#installMessageHandler()
      this._onInstallListeners(this.#g)

      // Phase 2: Self-Classification
      this.#emit('phase', { phase: 2, name: 'self-classification' })
      // Subclasses can override _onInstallListeners to add handlers

      // Phase 3: Parent Handshake
      this.#emit('phase', { phase: 3, name: 'parent-handshake' })
      await this.#parentHandshake(opts.handshakeTimeout ?? DEFAULT_HANDSHAKE_TIMEOUT)

      // Phase 4: Peer Discovery
      this.#emit('phase', { phase: 4, name: 'peer-discovery' })
      await this.#peerDiscovery(
        opts.discoveryChannel ?? DEFAULT_DISCOVERY_CHANNEL,
        opts.discoveryTimeout ?? DEFAULT_DISCOVERY_TIMEOUT
      )

      // Phase 5: Role Finalization
      this.#emit('phase', { phase: 5, name: 'role-finalization' })
      this.#finalizeRole()
      this.#state = 'ready'
      this._onReady()
      this.#emit('ready', { podId: this.podId, kind: this.#kind, role: this.#role })
    } catch (err) {
      this.#state = 'idle'
      this.#emit('error', { phase: 'boot', error: err })
      throw err
    }
  }

  // ── Shutdown ─────────────────────────────────────────────────

  /**
   * Gracefully shut down the pod.
   *
   * @param {object} [opts]
   * @param {boolean} [opts.silent] - Skip broadcasting POD_GOODBYE
   */
  async shutdown(opts = {}) {
    if (this.#state === 'shutdown' || this.#state === 'idle') return

    if (!opts.silent && this.#discoveryChannel) {
      try {
        this.#discoveryChannel.postMessage(createGoodbye({ podId: this.podId }))
      } catch { /* channel may already be closed */ }
    }

    if (this.#discoveryChannel) {
      this.#discoveryChannel.close()
      this.#discoveryChannel = null
    }

    if (this.#messageHandler && this.#g?.removeEventListener) {
      this.#g.removeEventListener('message', this.#messageHandler)
      this.#messageHandler = null
    }

    if (this.#g) {
      delete this.#g[POD_RUNTIME_KEY]
    }

    this.#peers.clear()
    this.#state = 'shutdown'
    this.#emit('shutdown', { podId: this.podId })
  }

  // ── Messaging ────────────────────────────────────────────────

  /**
   * Send a message to a specific peer via BroadcastChannel.
   *
   * @param {string} targetPodId
   * @param {*} payload
   */
  send(targetPodId, payload) {
    if (this.#state !== 'ready') {
      throw new Error('Pod is not ready')
    }
    if (!this.#discoveryChannel) {
      throw new Error('No discovery channel available')
    }
    this.#discoveryChannel.postMessage(
      createMessage({ from: this.podId, to: targetPodId, payload })
    )
  }

  /**
   * Broadcast a message to all peers via BroadcastChannel.
   *
   * @param {*} payload
   */
  broadcast(payload) {
    this.send('*', payload)
  }

  // ── Events ───────────────────────────────────────────────────

  /**
   * Register an event listener.
   * @param {string} event
   * @param {Function} cb
   */
  on(event, cb) {
    if (!this.#listeners.has(event)) this.#listeners.set(event, [])
    this.#listeners.get(event).push(cb)
  }

  /**
   * Remove an event listener.
   * @param {string} event
   * @param {Function} cb
   */
  off(event, cb) {
    const list = this.#listeners.get(event)
    if (!list) return
    const idx = list.indexOf(cb)
    if (idx !== -1) list.splice(idx, 1)
  }

  // ── Serialization ────────────────────────────────────────────

  /** @returns {object} Serializable snapshot */
  toJSON() {
    return {
      podId: this.podId,
      kind: this.#kind,
      role: this.#role,
      state: this.#state,
      capabilities: this.#capabilities,
      peerCount: this.#peers.size,
      peers: [...this.#peers.keys()],
    }
  }

  // ── Subclass hooks ───────────────────────────────────────────

  /**
   * Called during Phase 1 (Install Listeners). Override in subclasses
   * to install additional message handlers.
   * @param {object} _g - globalThis reference
   */
  _onInstallListeners(_g) { /* override me */ }

  /** Called during Phase 5 (Role Finalization) when boot completes. */
  _onReady() { /* override me */ }

  /**
   * Called for each incoming message that targets this pod.
   * @param {object} _msg
   */
  _onMessage(_msg) { /* override me */ }

  // ── Private: boot phases ─────────────────────────────────────

  #installMessageHandler() {
    if (!this.#g?.addEventListener) return
    this.#messageHandler = (event) => {
      const data = event.data
      if (!data || !data.type) return
      this.#handleIncoming(data)
    }
    this.#g.addEventListener('message', this.#messageHandler)
  }

  async #parentHandshake(timeout) {
    // Only attempt if we have a parent or opener
    const hasParent = this.#kind === 'iframe' || this.#kind === 'spawned'
    if (!hasParent) return

    const target = this.#kind === 'iframe'
      ? this.#g.parent
      : this.#g.opener

    if (!target || typeof target.postMessage !== 'function') return

    const hello = createHello({
      podId: this.podId,
      kind: this.#kind,
      capabilities: this.#capabilities,
    })

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), timeout)

      const handler = (event) => {
        const data = event.data
        if (data?.type === POD_HELLO_ACK && data.targetPodId === this.podId) {
          clearTimeout(timer)
          this.#g.removeEventListener('message', handler)
          this.#addPeer(data.podId, { kind: data.kind, role: 'parent' })
          this.#role = 'child'
          resolve()
        }
      }
      this.#g.addEventListener('message', handler)
      target.postMessage(hello, '*')
    })
  }

  async #peerDiscovery(channelName, timeout) {
    if (!this.#capabilities?.messaging?.broadcastChannel) return

    this.#discoveryChannel = new (this.#g.BroadcastChannel || BroadcastChannel)(channelName)

    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(), timeout)

      this.#discoveryChannel.onmessage = (event) => {
        const data = event.data
        if (!data || !data.type) return

        if (data.type === POD_HELLO && data.podId !== this.podId) {
          // Another pod announcing — respond with ACK and register
          this.#addPeer(data.podId, { kind: data.kind })
          this.#discoveryChannel.postMessage(
            createHelloAck({ podId: this.podId, kind: this.#kind, targetPodId: data.podId })
          )
        } else if (data.type === POD_HELLO_ACK && data.targetPodId === this.podId) {
          // Response to our announcement
          this.#addPeer(data.podId, { kind: data.kind })
        } else if (data.type === POD_GOODBYE) {
          this.#removePeer(data.podId)
        } else {
          this.#handleIncoming(data)
        }
      }

      // Announce ourselves
      this.#discoveryChannel.postMessage(
        createHello({ podId: this.podId, kind: this.#kind, capabilities: this.#capabilities })
      )

      // After timeout, switch to persistent listener
      setTimeout(() => {
        clearTimeout(timer)
        resolve()
      }, timeout)
    })
  }

  #finalizeRole() {
    // If role was set during parent handshake, keep it
    if (this.#role === 'child') return

    if (this.#peers.size === 0) {
      this.#role = 'autonomous'
    } else {
      this.#role = 'peer'
    }
  }

  // ── Private: message routing ─────────────────────────────────

  #handleIncoming(data) {
    switch (data.type) {
      case POD_HELLO: {
        // Late hello from a new peer (after initial discovery)
        if (data.podId !== this.podId) {
          this.#addPeer(data.podId, { kind: data.kind })
          if (this.#discoveryChannel) {
            this.#discoveryChannel.postMessage(
              createHelloAck({ podId: this.podId, kind: this.#kind, targetPodId: data.podId })
            )
          }
        }
        break
      }
      case POD_HELLO_ACK: {
        if (data.targetPodId === this.podId) {
          this.#addPeer(data.podId, { kind: data.kind })
        }
        break
      }
      case POD_GOODBYE: {
        this.#removePeer(data.podId)
        break
      }
      case POD_MESSAGE:
      case POD_RPC_REQUEST:
      case POD_RPC_RESPONSE: {
        // Deliver if addressed to us or broadcast
        if (data.to === this.podId || data.to === '*') {
          this._onMessage(data)
          this.#emit('message', data)
        }
        break
      }
    }
  }

  #addPeer(podId, info) {
    if (podId === this.podId) return
    const isNew = !this.#peers.has(podId)
    this.#peers.set(podId, { ...info, podId, lastSeen: Date.now() })
    if (isNew) {
      this.#emit('peer:found', { podId, ...info })
    }
  }

  #removePeer(podId) {
    if (this.#peers.delete(podId)) {
      this.#emit('peer:lost', { podId })
    }
  }

  // ── Private: event emitter ───────────────────────────────────

  #emit(event, data) {
    const list = this.#listeners.get(event)
    if (!list) return
    for (const fn of list) {
      try { fn(data) } catch { /* listener errors don't crash the pod */ }
    }
  }
}

// ── pod/injected-pod.mjs ──
/**
 * injected-pod.mjs — Lightweight pod for injection into arbitrary pages.
 *
 * Extends Pod with page-context capabilities: text extraction, structured
 * data extraction, and a visual overlay indicator. Designed for Chrome
 * extension injection or bookmarklet use.
 */


const OVERLAY_ID = '__pod_overlay__'

class InjectedPod extends Pod {
  #extensionBridge = null

  /**
   * @param {object} [opts]
   * @param {object} [opts.extensionBridge] - Chrome extension port for relaying
   */
  constructor(opts = {}) {
    super()
    this.#extensionBridge = opts.extensionBridge || null
  }

  /** Page context: URL, title, origin, favicon */
  get pageContext() {
    const g = this._getGlobal()
    if (!g?.document) return null
    return {
      url: g.location?.href || '',
      title: g.document.title || '',
      origin: g.location?.origin || '',
      favicon: g.document.querySelector('link[rel~="icon"]')?.href || '',
    }
  }

  /**
   * Extract visible text content from the page.
   * @returns {string}
   */
  extractText() {
    const g = this._getGlobal()
    if (!g?.document?.body) return ''
    return g.document.body.innerText || ''
  }

  /**
   * Extract structured page data.
   * @returns {object}
   */
  extractStructured() {
    const g = this._getGlobal()
    if (!g?.document) return {}

    const doc = g.document
    const metas = {}
    for (const el of doc.querySelectorAll('meta[name], meta[property]')) {
      const key = el.getAttribute('name') || el.getAttribute('property')
      if (key) metas[key] = el.getAttribute('content') || ''
    }

    const headings = []
    for (const el of doc.querySelectorAll('h1, h2, h3')) {
      headings.push({ tag: el.tagName.toLowerCase(), text: el.textContent?.trim() || '' })
    }

    return {
      title: doc.title || '',
      url: g.location?.href || '',
      meta: metas,
      headings,
    }
  }

  /**
   * Show a floating overlay indicator on the page.
   * Blue circle (48px) fixed at bottom-right with "Pod" label.
   */
  showOverlay() {
    const g = this._getGlobal()
    if (!g?.document) return

    if (g.document.getElementById(OVERLAY_ID)) return

    const el = g.document.createElement('div')
    el.id = OVERLAY_ID
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      width: '48px',
      height: '48px',
      borderRadius: '50%',
      background: '#3b82f6',
      color: '#fff',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '12px',
      fontWeight: 'bold',
      fontFamily: 'system-ui, sans-serif',
      zIndex: '2147483647',
      cursor: 'pointer',
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      userSelect: 'none',
    })
    el.textContent = 'Pod'
    el.title = `Pod: ${this.podId?.slice(0, 8) || 'booting'}`
    g.document.body.appendChild(el)
  }

  /** Hide the overlay indicator. */
  hideOverlay() {
    const g = this._getGlobal()
    if (!g?.document) return
    const el = g.document.getElementById(OVERLAY_ID)
    if (el) el.remove()
  }

  _onReady() {
    this.showOverlay()
  }

  _onMessage(msg) {
    // Forward to extension bridge if available
    if (this.#extensionBridge && typeof this.#extensionBridge.postMessage === 'function') {
      this.#extensionBridge.postMessage(msg)
    }
    this.emit('pod:message', msg)
  }

  /** Emit helper for subclass/external use */
  emit(event, data) {
    // Use the parent's on/off system by invoking listeners directly
    // This is a public-facing emit that mirrors the internal #emit
    const listeners = []
    // Call registered listeners via a temporary capture
    this._emitPublic(event, data)
  }

  /** @internal */
  _emitPublic(event, data) {
    // Pod base class has private #emit; we re-dispatch through on() listeners
    // by using a workaround: store listeners we can call
  }

  /** @internal — access the global reference set during boot */
  _getGlobal() {
    // During boot, Pod stores g internally. For InjectedPod pre-boot, use globalThis
    return globalThis
  }

  async shutdown(opts = {}) {
    this.hideOverlay()
    await super.shutdown(opts)
  }
}

// ── Boot ──
const pod = new InjectedPod();
pod.boot({ discoveryTimeout: 2000 }).then(() => {
  console.log('[pod-inject] Pod ready:', pod.podId);
}).catch((err) => {
  console.warn('[pod-inject] Boot failed:', err.message);
});
})();
