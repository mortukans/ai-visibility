// API-key helpers built on the Web Crypto API, so the same code runs in Node and
// in a Cloudflare Worker (no node:crypto).

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A fresh, unguessable API key shown to the user once. */
export function generateApiKey(): string {
  return "av_" + base64url(crypto.getRandomValues(new Uint8Array(24)));
}

/** SHA-256 of a raw key — only the hash is stored, never the key itself. */
export async function hashKey(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return hex(new Uint8Array(digest));
}
