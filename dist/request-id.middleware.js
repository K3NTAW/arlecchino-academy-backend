import { randomUUID } from "node:crypto";
import { logInfo } from "./logger";
export function requestIdMiddleware(req, res, next) {
    const requestWithId = req;
    requestWithId.requestId = randomUUID();
    res.setHeader("x-request-id", requestWithId.requestId);
    logInfo("request.start", { requestId: requestWithId.requestId, path: req.path });
    next();
}
