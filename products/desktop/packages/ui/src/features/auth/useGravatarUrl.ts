import { useEffect, useState } from "react";

// Gravatar accepts a SHA-256 hex hash of the lowercased, trimmed email, so we hash
// with the built-in Web Crypto API rather than pulling in an md5 dependency. `d=404`
// makes Gravatar return 404 (instead of a default silhouette) when the address has no
// avatar, so the <img> errors and the initials fallback stays visible.
async function gravatarUrlForEmail(
  normalizedEmail: string,
): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle) return undefined;
  const bytes = new TextEncoder().encode(normalizedEmail);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://www.gravatar.com/avatar/${hash}?s=96&d=404`;
}

const gravatarUrls = new Map<string, string>();

interface HashedGravatar {
  email: string;
  url: string | undefined;
}

export function useGravatarUrl(email?: string | null): string | undefined {
  const normalized = email?.trim().toLowerCase() || undefined;
  const cached = normalized ? gravatarUrls.get(normalized) : undefined;
  const [hashed, setHashed] = useState<HashedGravatar | null>(null);

  useEffect(() => {
    if (!normalized || cached) return;
    let cancelled = false;
    gravatarUrlForEmail(normalized)
      .then((url) => {
        if (url) gravatarUrls.set(normalized, url);
        if (!cancelled) setHashed({ email: normalized, url });
      })
      .catch(() => {
        if (!cancelled) setHashed({ email: normalized, url: undefined });
      });
    return () => {
      cancelled = true;
    };
  }, [normalized, cached]);

  if (cached) return cached;
  return hashed && hashed.email === normalized ? hashed.url : undefined;
}
