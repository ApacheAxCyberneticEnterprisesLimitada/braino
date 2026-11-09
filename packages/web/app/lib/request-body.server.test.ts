import { describe, expect, it } from "vitest";
import {
  readBoundedJson,
  readBoundedText,
  readBoundedUrlEncodedForm,
} from "./request-body.server.js";

describe("bounded request bodies", () => {
  it("parses JSON below the byte limit", async () => {
    const request = new Request("https://doco.example/hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: true }),
    });
    await expect(readBoundedJson(request, 64)).resolves.toEqual({ ok: true });
  });

  it("stops reading chunked bodies once the byte limit is crossed", async () => {
    const request = new Request("https://doco.example/hook", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("12345678"));
          controller.enqueue(new TextEncoder().encode("9"));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    await expect(readBoundedText(request, 8)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("rejects an oversized declared content length before reading", async () => {
    const request = new Request("https://doco.example/hook", {
      method: "POST",
      headers: { "content-length": "100" },
      body: "{}",
    });
    await expect(readBoundedText(request, 8)).rejects.toMatchObject({
      status: 413,
    });
  });

  it("parses bounded browser forms and rejects other media types", async () => {
    const form = await readBoundedUrlEncodedForm(
      new Request("https://doco.example", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "intent=setup&owner_name=Ada",
      }),
      64,
    );
    expect(form.get("intent")).toBe("setup");
    await expect(
      readBoundedUrlEncodedForm(
        new Request("https://doco.example", {
          method: "POST",
          headers: { "content-type": "multipart/form-data" },
          body: "ignored",
        }),
        64,
      ),
    ).rejects.toMatchObject({ status: 415 });
  });
});
