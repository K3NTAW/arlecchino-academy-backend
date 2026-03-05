import { describe, expect, it } from "vitest";
import { extractPdfContent } from "./pdf-extractor";

describe("extractPdfContent", () => {
  it("uses OCR fallback when parser returns no text", async () => {
    const fakeBuffer = Buffer.from("not-a-real-pdf");
    const result = await extractPdfContent(fakeBuffer, {
      extractTextFromPdfBuffer: async () => "ocr extracted text"
    });

    expect(result.usedOcrFallback).toBe(true);
    expect(result.text).toBe("ocr extracted text");
  });
});
