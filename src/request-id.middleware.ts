import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { logInfo } from "./logger";
import type { RequestWithId } from "./types";

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const requestWithId = req as RequestWithId;
  requestWithId.requestId = randomUUID();
  res.setHeader("x-request-id", requestWithId.requestId);
  logInfo("request.start", { requestId: requestWithId.requestId, path: req.path });
  next();
}
