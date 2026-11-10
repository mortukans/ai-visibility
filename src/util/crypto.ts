// AES-GCM encryption for data at rest (the stored OpenRouter key), built on Web
// Crypto so it runs in both Node and a Cloudflare Worker. The 256-bit key is
// derived from a deployment secret (KEY_SECRET) via SHA-256.

export interface Cipher {
  encrypt(plain: string): Promise<string>;
  decrypt(blob: string): Promise<string>;
}

/** Returns a cipher when a secret is set, or null (store values in the clear). */
export function makeCipher(secret?: string | null): Cipher | null {
  return secret ? new AesGcmCipher(secret) : null;
}

function b64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function unb64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

class AesGcmCipher implements Cipher {
  private keyPromise?: Promise<CryptoKey>;

  constructor(private secret: string) {}

  private key(): Promise<CryptoKey> {
    this.keyPromise ??= (async () => {
      const material = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(this.secret),
      );
      return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
    })();
    return this.keyPromise;
  }

  async encrypt(plain: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipherText = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key(), new TextEncoder().encode(plain)),
    );
    return `${b64(iv)}.${b64(cipherText)}`;
  }

  async decrypt(blob: string): Promise<string> {
    const [ivPart, dataPart] = blob.split(".");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(ivPart) },
      await this.key(),
      unb64(dataPart),
    );
    return new TextDecoder().decode(plain);
  }
}
