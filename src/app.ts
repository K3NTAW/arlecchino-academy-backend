import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { createHash } from "node:crypto";
import {
  ChallengeAttemptRequestSchema,
  ChallengeAttemptResponseSchema,
  ChallengeSchema,
  GenerateRequestSchema,
  LessonBundleSchema
} from "@academy/shared";
import { env } from "./config";
import { errorMiddleware } from "./error.middleware";
import { logError, logInfo } from "./logger";
import { requestIdMiddleware } from "./request-id.middleware";
import { extractPdfContent } from "./pdf/pdf-extractor";
import type { AIProvider } from "./ai/provider";
import { validateChallengeQuality } from "./ai/quality";
import type { RequestWithId } from "./types";
import { DatabaseService } from "./db";
import { LocalJavaEvaluator, type JavaEvaluator } from "./evaluator/java-evaluator";

const upload = multer({
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

function buildHash(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}

function ensureAuthorized(req: express.Request, res: express.Response): boolean {
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== env.ACCESS_TOKEN) {
    res.status(401).json({ message: "Unauthorized" });
    return false;
  }
  return true;
}

type CreateAppOptions = {
  javaEvaluator?: JavaEvaluator;
};

export function createApp(aiProvider: AIProvider, db: DatabaseService, options: CreateAppOptions = {}) {
  const app = express();
  const javaEvaluator = options.javaEvaluator ?? new LocalJavaEvaluator();

  app.use(express.json({ limit: "2mb" }));
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(
    rateLimit({
      max: 60,
      windowMs: 60_000
    })
  );
  app.use(requestIdMiddleware);

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/login", (req, res) => {
    const body = req.body as { accessCode?: string };
    if ((body.accessCode ?? "") !== env.ACCESS_CODE) {
      res.status(401).json({ message: "Invalid access code." });
      return;
    }
    res.json({ token: env.ACCESS_TOKEN });
  });

  app.post("/api/logout", (req, res) => {
    if (!ensureAuthorized(req, res)) {
      return;
    }
    res.json({ ok: true });
  });

  app.post("/api/upload", upload.single("pdf"), async (req, res, next) => {
    try {
      if (!ensureAuthorized(req, res)) {
        return;
      }
      const requestId = (req as RequestWithId).requestId;
      if (!req.file) {
        res.status(400).json({ message: "PDF file is required." });
        return;
      }
      const extracted = await extractPdfContent(req.file.buffer);
      logInfo("pdf.extracted", {
        requestId,
        textLength: extracted.text.length,
        usedOcrFallback: extracted.usedOcrFallback
      });
      res.json(extracted);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/generate", async (req, res, next) => {
    try {
      if (!ensureAuthorized(req, res)) {
        return;
      }
      const requestId = (req as RequestWithId).requestId;
      const body = req.body as { extractedText: string; language: "en" | "sr"; title?: string };
      const input = GenerateRequestSchema.parse({
        extractedText: body.extractedText,
        language: body.language
      });
      const hash = buildHash(input.extractedText);
      const cached = await db.findLessonByHashAndLanguage(hash, input.language);
      if (cached) {
        const lessonPayload = {
          title: cached.lesson.title,
          summary: cached.lesson.summary,
          keyTerms: cached.lesson.keyTerms,
          insights: cached.lesson.insights,
          language: cached.lesson.language
        };
        const challengePayload = cached.challenges.map((challenge) => ({
          ...challenge.payload,
          id: String(challenge.id),
          difficulty: challenge.difficulty
        }));
        const parsedCached = LessonBundleSchema.parse({
          lesson: lessonPayload,
          challenges: challengePayload
        });
        res.json({
          ...parsedCached,
          lessonId: cached.lesson.id,
          qualityIssues: [],
          cached: true
        });
        return;
      }
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("AI request timeout")), env.REQUEST_TIMEOUT_MS)
      );

      const generated = (await Promise.race([
        aiProvider.generateLessonBundle(input),
        timeoutPromise
      ])) as unknown;

      const parsed = LessonBundleSchema.parse(generated);
      const qualityIssues = validateChallengeQuality(parsed, input.extractedText);

      if (qualityIssues.length > 0) {
        logError("generation.quality.issues", { requestId, qualityIssues });
      }

      const persisted = await db.saveGeneratedLesson({
        title: body.title ?? parsed.lesson.title,
        hash,
        extractedText: input.extractedText,
        language: input.language,
        lesson: parsed.lesson,
        challenges: parsed.challenges
      });
      const stored = await db.getLessonById(persisted.lessonId);
      const returnChallenges =
        stored?.challenges.map((challenge) => ({
          ...challenge.payload,
          id: String(challenge.id),
          difficulty: challenge.difficulty
        })) ?? parsed.challenges;

      res.json({
        lesson: parsed.lesson,
        challenges: returnChallenges,
        lessonId: persisted.lessonId,
        qualityIssues,
        cached: false
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/dashboard", async (req, res, next) => {
    try {
      if (!ensureAuthorized(req, res)) {
        return;
      }
      const stats = await db.getDashboardStats();
      res.json(stats);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/state", async (req, res, next) => {
    try {
      if (!ensureAuthorized(req, res)) {
        return;
      }
      const state = await db.getStateSnapshot();
      res.json({
        authenticated: true,
        ...state
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/lessons", async (req, res, next) => {
    try {
      if (!ensureAuthorized(req, res)) {
        return;
      }
      const page = Math.max(1, Number(req.query.page ?? 1));
      const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize ?? 20)));
      const lessons = await db.getLessons({ page, pageSize });
      res.json({
        items: lessons.items,
        total: lessons.total,
        page,
        pageSize
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/lessons/:lessonId", async (req, res, next) => {
    try {
      if (!ensureAuthorized(req, res)) {
        return;
      }
      const lessonId = Number(req.params.lessonId);
      const lessonData = await db.getLessonById(lessonId);
      if (!lessonData) {
        res.status(404).json({ message: "Lesson not found." });
        return;
      }
      res.json({
        lesson: {
          id: lessonData.lesson.id,
          title: lessonData.lesson.title,
          summary: lessonData.lesson.summary,
          keyTerms: lessonData.lesson.keyTerms,
          insights: lessonData.lesson.insights,
          language: lessonData.lesson.language
        },
        challenges: lessonData.challenges.map((challenge) => {
          const parsed = ChallengeSchema.parse({
            ...challenge.payload,
            id: String(challenge.id),
            type: challenge.type
          });
          return {
            ...parsed,
            id: challenge.id,
            difficulty: challenge.difficulty
          };
        })
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/challenges/:challengeId", async (req, res, next) => {
    try {
      if (!ensureAuthorized(req, res)) {
        return;
      }
      const challengeId = Number(req.params.challengeId);
      const challenge = await db.getChallengeById(challengeId);
      if (!challenge) {
        res.status(404).json({ message: "Challenge not found." });
        return;
      }
      res.json({
        id: challenge.id,
        type: challenge.type,
        difficulty: challenge.difficulty,
        ...challenge.payload
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/challenges/:challengeId/attempt", async (req, res, next) => {
    try {
      if (!ensureAuthorized(req, res)) {
        return;
      }
      const challengeId = Number(req.params.challengeId);
      const submission = ChallengeAttemptRequestSchema.parse(req.body);
      const challenge = await db.getChallengeById(challengeId);
      if (!challenge) {
        res.status(404).json({ message: "Challenge not found." });
        return;
      }

      const parsedChallenge = ChallengeSchema.parse({
        ...challenge.payload,
        id: String(challenge.id),
        type: challenge.type
      });

      if (submission.type !== parsedChallenge.type) {
        res.status(400).json({ message: "Attempt type does not match challenge type." });
        return;
      }

      const intent = submission.type === "coding" ? submission.intent : "submit";
      let isCorrect = false;
      let evaluation: unknown;

      if (parsedChallenge.type === "mcq" && submission.type === "mcq") {
        isCorrect = submission.selectedIndex === parsedChallenge.correctIndex;
        evaluation = {
          type: "mcq" as const,
          selectedIndex: submission.selectedIndex,
          correctIndex: parsedChallenge.correctIndex,
          explanation: parsedChallenge.explanation,
          whyWrongExplanations: parsedChallenge.whyWrongExplanations
        };
      } else if (parsedChallenge.type === "coding" && submission.type === "coding") {
        const codeResult = await javaEvaluator.evaluate({
          code: submission.code,
          testCases: parsedChallenge.testCases
        });
        isCorrect = codeResult.isCorrect;
        evaluation = {
          type: "coding" as const,
          code: submission.code,
          hint: parsedChallenge.hint,
          ahaInsight: parsedChallenge.ahaInsight,
          testResults: codeResult.testResults
        };
      } else {
        res.status(400).json({ message: "Unsupported challenge attempt payload." });
        return;
      }

      const result =
        intent === "submit"
          ? await db.saveAttempt(challengeId, isCorrect, {
              answerPayload: submission,
              evaluationPayload: evaluation
            })
          : await db.getProgressStats().then((stats) => ({
              gainedXp: 0,
              totalXp: stats.xp,
              level: stats.level,
              streakDays: stats.streakDays
            }));
      res.json(
        ChallengeAttemptResponseSchema.parse({
          ok: true,
          intent,
          ...result,
          isCorrect,
          evaluation
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/progress", async (req, res, next) => {
    try {
      if (!ensureAuthorized(req, res)) {
        return;
      }
      const stats = await db.getProgressStats();
      res.json(stats);
    } catch (error) {
      next(error);
    }
  });

  app.use(errorMiddleware);
  return app;
}
