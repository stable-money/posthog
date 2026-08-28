import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useGravatarUrl } from "./useGravatarUrl";

async function gravatarUrl(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(email),
  );
  const hash = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `https://www.gravatar.com/avatar/${hash}?s=96&d=404`;
}

describe("useGravatarUrl", () => {
  it("returns undefined when there is no email", () => {
    const { result } = renderHook(() => useGravatarUrl(undefined));
    expect(result.current).toBeUndefined();
  });

  it("builds a SHA-256 Gravatar URL with the d=404 fallback", async () => {
    const { result } = renderHook(() => useGravatarUrl("user@example.com"));
    await waitFor(() =>
      expect(result.current).toBe(
        "https://www.gravatar.com/avatar/b4c9a289323b21a01c3e940f150eb9b8c542587f1abfd8f0e1cc1ffc5e475514?s=96&d=404",
      ),
    );
  });

  it("lowercases and trims the email before hashing", async () => {
    const { result } = renderHook(() => useGravatarUrl("  TEST@Example.com "));
    await waitFor(() =>
      expect(result.current).toBe(
        "https://www.gravatar.com/avatar/973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b?s=96&d=404",
      ),
    );
  });

  it("resolves synchronously on a later mount of an email hashed before", async () => {
    const expected = await gravatarUrl("remount@example.com");
    const first = renderHook(() => useGravatarUrl("remount@example.com"));
    await waitFor(() => expect(first.result.current).toBe(expected));
    first.unmount();

    const second = renderHook(() => useGravatarUrl("remount@example.com"));
    expect(second.result.current).toBe(expected);
  });

  it("never shows the previous person's URL while a changed email is hashing", async () => {
    const firstUrl = await gravatarUrl("first@example.com");
    const secondUrl = await gravatarUrl("second@example.com");
    const { result, rerender } = renderHook(
      ({ email }) => useGravatarUrl(email),
      { initialProps: { email: "first@example.com" } },
    );
    await waitFor(() => expect(result.current).toBe(firstUrl));

    rerender({ email: "second@example.com" });
    expect(result.current).not.toBe(firstUrl);

    await waitFor(() => expect(result.current).toBe(secondUrl));
  });
});
