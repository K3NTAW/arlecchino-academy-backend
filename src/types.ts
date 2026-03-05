import type { Request } from "express";

export interface RequestWithId extends Request {
  requestId: string;
}

export interface ExtractedPdf {
  text: string;
  imageCount: number;
  usedOcrFallback: boolean;
}
