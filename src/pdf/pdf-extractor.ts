import pdf from "pdf-parse";
import type { ExtractedPdf } from "../types";

export interface OcrService {
  extractTextFromPdfBuffer(buffer: Buffer): Promise<string>;
}

class NoopOcrService implements OcrService {
  async extractTextFromPdfBuffer(): Promise<string> {
    return "";
  }
}

export async function extractPdfContent(
  fileBuffer: Buffer,
  ocrService: OcrService = new NoopOcrService()
): Promise<ExtractedPdf> {
  let text = "";
  try {
    const parsed = await pdf(fileBuffer);
    text = parsed.text?.trim() ?? "";
  } catch {
    text = "";
  }

  if (text.length > 0) {
    return {
      text,
      imageCount: 0,
      usedOcrFallback: false
    };
  }

  const ocrText = (await ocrService.extractTextFromPdfBuffer(fileBuffer)).trim();
  return {
    text: ocrText,
    imageCount: 0,
    usedOcrFallback: true
  };
}
