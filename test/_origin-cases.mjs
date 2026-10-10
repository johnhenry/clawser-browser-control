// Shared table for origin-validation tests (background.js and content.js must agree).
export const GOOD = [
  ['https://clawser.example.com', 'https://clawser.example.com'],
  ['  https://clawser.example.com/  ', 'https://clawser.example.com'],
  ['https://clawser.example.com:8443', 'https://clawser.example.com:8443'],
  ['HTTPS://Clawser.Example.COM', 'https://clawser.example.com'],
];
export const BAD = [
  '', '   ', 'clawser.example.com', 'http://clawser.example.com', 'ftp://clawser.example.com',
  'https://*.example.com', 'https://clawser.example.com/*', 'https://clawser.example.com/app',
  'https://clawser.example.com/?x=1', 'https://clawser.example.com/#frag',
  'https://user:pw@clawser.example.com', 'https://com', 'https://localhost', 'https://127.0.0.1',
  'https://10.0.0.5', 'https://[::1]', 'https://example.com.', 'https://exa mple.com',
  'file:///etc', 'javascript:alert(1)', 'https://', null, undefined, 42, {}, 'https://' + 'a'.repeat(300) + '.com',
  'https://clawser.erisera.com', // already built in: not a custom origin
  '*://*/*', '<all_urls>',
];
