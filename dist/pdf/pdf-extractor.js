import pdf from "pdf-parse";
class NoopOcrService {
    async extractTextFromPdfBuffer() {
        return "";
    }
}
export async function extractPdfContent(fileBuffer, ocrService = new NoopOcrService()) {
    let text = "";
    try {
        const parsed = await pdf(fileBuffer);
        text = parsed.text?.trim() ?? "";
    }
    catch {
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
