import { logError } from "./logger";
export function errorMiddleware(err, req, res) {
    logError("request.error", { path: req.path, error: String(err) });
    res.status(500).json({
        message: "Something went wrong while processing your request."
    });
}
