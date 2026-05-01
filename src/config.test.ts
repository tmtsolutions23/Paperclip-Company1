import { describe, expect, it } from "vitest";
import { readConfig } from "./config.js";

describe("readConfig", () => {
  it("falls back to RENDER_EXTERNAL_URL when PUBLIC_BASE_URL is unset", () => {
    const config = readConfig({
      RENDER_EXTERNAL_URL: "https://tmta-voice-edge.onrender.com",
    });

    expect(config.PUBLIC_BASE_URL).toBe("https://tmta-voice-edge.onrender.com");
  });

  it("prefers PUBLIC_BASE_URL when both values are present", () => {
    const config = readConfig({
      PUBLIC_BASE_URL: "https://voice.example.com",
      RENDER_EXTERNAL_URL: "https://tmta-voice-edge.onrender.com",
    });

    expect(config.PUBLIC_BASE_URL).toBe("https://voice.example.com");
  });
});
