import { randomBytes } from 'crypto';

/** Cryptographically-random nonce for the webview Content-Security-Policy.
 *  Base64 is a valid value for both a CSP `nonce-` source and the HTML
 *  `nonce` attribute. */
export function getNonce(): string {
  return randomBytes(16).toString('base64');
}
