import type { Request, Response } from "express";
import { logError } from "./logger";

export function errorMiddleware(
  err: unknown,
  req: Request,
  res: Response
): void {
  logError("request.error", { path: req.path, error: String(err) });
  res.status(500).json({
    message: "Something went wrong while processing your request."
  });
}
