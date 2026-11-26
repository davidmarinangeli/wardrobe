import { describe, expect, it } from "vitest";
import {
  defaultRedirectUri,
  formatBytes,
  formatOverrides,
  formatUptime,
  parseOverrides,
  secretLabel,
  validateFolderId,
  validatePort,
  validateRedirectUri,
  validateSecretValue,
} from "../src/validation.js";

describe("parseOverrides", () => {
  it("keeps valid KEY=value lines in order and skips blanks and comments", () => {
    const { entries, errors } = parseOverrides("OPENAI_IMAGE_MODEL=gpt-image-2\n\n# a comment\nGEMINI_IMAGE_SIZE= 2K \r\nEMPTY=");
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { key: "OPENAI_IMAGE_MODEL", value: "gpt-image-2" },
      { key: "GEMINI_IMAGE_SIZE", value: "2K" },
      { key: "EMPTY", value: "" },
    ]);
    expect(formatOverrides(entries)).toBe("OPENAI_IMAGE_MODEL=gpt-image-2\nGEMINI_IMAGE_SIZE=2K\nEMPTY=");
  });

  it("rejects malformed lines", () => {
    const { errors } = parseOverrides("openai_image_model=x\nNO_EQUALS\n=value\nBAD-KEY=1");
    expect(errors.map((e) => e.line)).toEqual([1, 2, 3, 4]);
    expect(errors[0].message).toBe("Line 1: write KEY=value, with KEY in capital letters, digits and _");
  });

  it("sends secrets to the key fields", () => {
    for (const name of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY_TEST", "GEMINI_API_KEY_PROD", "MINIMAX_API_KEY", "GOOGLE_DRIVE_CLIENT_SECRET", "GEMINI_API_KEY"]) {
      const { entries, errors } = parseOverrides(`${name}=sk-secret`);
      expect(entries).toEqual([]);
      expect(errors[0].message).toBe(`Line 1: ${name} is a secret, use the key fields above`);
    }
  });

  it("rejects keys the panel owns", () => {
    for (const name of ["WARDROBE_DATA_DIR", "WARDROBE_CACHE_DIR", "WARDROBE_MANAGED_CONFIG", "WARDROBE_ALLOWED_HOSTS", "NODE_OPTIONS"]) {
      expect(parseOverrides(`${name}=x`).errors[0].message).toContain("set by the desktop app itself");
    }
    expect(parseOverrides("AI_PROVIDER=gemini").errors[0].message).toContain("Provider select");
    expect(parseOverrides("GOOGLE_DRIVE_FOLDER_ID=abcde").errors[0].message).toContain("Google Drive section");
    expect(parseOverrides("A=1\nA=2").errors[0].message).toBe("Line 2: A appears twice");
  });
});

describe("port validation", () => {
  it("accepts 1 to 65535 only", () => {
    expect(validatePort("5174")).toEqual({ port: 5174 });
    expect(validatePort(" 1 ")).toEqual({ port: 1 });
    expect(validatePort("65535")).toEqual({ port: 65535 });
    for (const bad of ["0", "65536", "", "51.73", "-1", "abc", "5173x"]) {
      expect(validatePort(bad).error).toBe("Enter a port number between 1 and 65535.");
    }
  });
  it("derives the Drive redirect URI from the port", () => {
    expect(defaultRedirectUri(5174)).toBe("http://localhost:5174/api/google-drive/oauth/callback");
  });
});

describe("Google Drive validation", () => {
  it("matches the server's rules", () => {
    expect(validateRedirectUri("")).toBeNull();
    expect(validateRedirectUri("http://localhost:5173/api/google-drive/oauth/callback")).toBeNull();
    expect(validateRedirectUri("https://mac.tail.ts.net/api/google-drive/oauth/callback")).toBeNull();
    expect(validateRedirectUri("http://example.com/api/google-drive/oauth/callback")).toMatch(/https, or http on localhost/);
    expect(validateRedirectUri("http://localhost:5173/other")).not.toBeNull();
    expect(validateRedirectUri("http://localhost:5173/api/google-drive/oauth/callback?x=1")).not.toBeNull();
    expect(validateFolderId("")).toBeNull();
    expect(validateFolderId("1AbC_d-EfG")).toBeNull();
    expect(validateFolderId("abc")).not.toBeNull();
    expect(validateFolderId("https://drive.google.com/x")).not.toBeNull();
  });
});

describe("formatting", () => {
  it("labels secrets with the hint only", () => {
    expect(secretLabel(undefined)).toBe("Not set");
    expect(secretLabel({ present: false, hint: null })).toBe("Not set");
    expect(secretLabel({ present: true, hint: "…ab12" })).toBe("Set, ends with …ab12");
    expect(secretLabel({ present: true, hint: "…" })).toBe("Set");
  });
  it("checks secret values", () => {
    expect(validateSecretValue("  ")).toBe("Paste the key first.");
    expect(validateSecretValue("a\nb")).toBe("The key must be a single line.");
    expect(validateSecretValue(" sk-1 ")).toBeNull();
  });
  it("formats sizes and uptimes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(470 * 1024 * 1024)).toBe("470 MB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatUptime(42)).toBe("42 s");
    expect(formatUptime(3720)).toBe("1 h 2 min");
    expect(formatUptime(90000)).toBe("1 d 1 h");
  });
});
