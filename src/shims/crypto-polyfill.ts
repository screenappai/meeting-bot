/*
 * Ensures global Web Crypto API is available at runtime (especially on Node 18),
 * which some Azure SDK internals expect (globalThis.crypto and crypto.randomUUID).
 *
 * This shim is a no-op on Node 20+ where global Web Crypto is available by default.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import nodeCrypto from 'node:crypto';

const g: any = globalThis as any;

try {
  // Attach Web Crypto if missing
  if (!g.crypto) {
    if ((nodeCrypto as any).webcrypto) {
      g.crypto = (nodeCrypto as any).webcrypto;
    }
  }

  // Ensure randomUUID exists on crypto
  if (!g.crypto || typeof g.crypto.randomUUID !== 'function') {
    const rnd = (nodeCrypto as any).randomUUID;
    if (typeof rnd === 'function') {
      g.crypto = g.crypto || {};
      g.crypto.randomUUID = rnd.bind(nodeCrypto);
    } else {
      // Final fallback to uuid v4 if Node's randomUUID is not present
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { v4: uuidv4 } = require('uuid');
      g.crypto = g.crypto || {};
      g.crypto.randomUUID = uuidv4;
    }
  }
} catch {
  // Best-effort shim; swallow any unexpected errors to avoid crashing at startup
}

// Optional minimal diagnostics in development
if (process.env.NODE_ENV !== 'production') {
  const hasCrypto = typeof (globalThis as any).crypto !== 'undefined';
  const hasUUID = hasCrypto && typeof (globalThis as any).crypto.randomUUID === 'function';
  // Use console.debug to avoid noisy logs
  // eslint-disable-next-line no-console
  console.debug(`[bootstrap] WebCrypto available: ${hasCrypto}, randomUUID: ${hasUUID}, Node: ${process.version}`);
}
