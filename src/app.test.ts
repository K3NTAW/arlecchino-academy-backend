import { describe, expect, it } from "vitest";
import request from "supertest";
import { LessonBundleSchema } from "@academy/shared";
import { createApp } from "./app";
import type { AIProvider } from "./ai/provider";
import { env } from "./config";
import type { DatabaseService } from "./db";

const testProvider: AIProvider = {
  async generateLessonBundle() {
    return LessonBundleSchema.parse({
      lesson: {
        title: "Test lesson",
        summary: "Test summary",
        keyTerms: [{ term: "term", definition: "definition" }],
        insights: [{ headline: "headline", explanation: "explanation" }],
        language: "en"
      },
      challenges: [
        {
          id: "mcq-1",
          type: "mcq",
          question: "Q?",
          options: ["A", "B", "C", "D"],
          correctIndex: 0,
          explanation: "E",
          whyWrongExplanations: ["x", "y", "z"]
        }
      ]
    });
  }
};

const fakeDb = {
  async findLessonByHashAndLanguage() {
    return null;
  },
  async saveGeneratedLesson() {
    return { lessonId: 1 };
  },
  async getLessonById() {
    return {
      lesson: {
        id: 1,
        documentId: 1,
        title: "Test lesson",
        summary: "Test summary",
        keyTerms: [{ term: "term", definition: "definition" }],
        insights: [{ headline: "headline", explanation: "explanation" }],
        language: "en"
      },
      challenges: [
        {
          id: 10,
          lessonId: 1,
          type: "mcq",
          difficulty: "easy",
          payload: {
            type: "mcq",
            question: "Q?",
            options: ["A", "B", "C", "D"],
            correctIndex: 0,
            explanation: "Explanation that is long enough for validation pass in tests.",
            whyWrongExplanations: ["x", "y", "z"]
          }
        }
      ]
    };
  },
  async getDashboardStats() {
    return {
      xp: 0,
      documentCount: 0,
      masteryPercent: 0,
      streakDays: 0,
      level: "Fledgling",
      recentLesson: null,
      recentLessons: []
    };
  },
  async getStateSnapshot() {
    return {
      dashboard: {
        xp: 0,
        documentCount: 0,
        masteryPercent: 0,
        streakDays: 0,
        level: "Fledgling",
        recentLesson: null,
        recentLessons: []
      },
      progress: {
        xp: 0,
        level: "Fledgling",
        masteryPercent: 0,
        streakDays: 0,
        badges: ["Fledgling"],
        topics: [{ name: "Java Foundations", mastery: 0 }],
        xpToNextLevel: 100
      }
    };
  },
  async getLessons() {
    return {
      items: [],
      total: 0
    };
  },
  async getProgressStats() {
    return {
      xp: 0,
      level: "Fledgling",
      masteryPercent: 0,
      streakDays: 0,
      badges: ["Fledgling"],
      topics: [{ name: "Java Foundations", mastery: 0 }],
      xpToNextLevel: 100
    };
  },
  async getChallengeById() {
    return null;
  },
  async saveAttempt() {
    return { gainedXp: 10, totalXp: 10, level: "Fledgling", streakDays: 1 };
  }
} as unknown as DatabaseService;

const app = createApp(testProvider, fakeDb);

describe("backend app", () => {
  it("returns health state", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("generates lesson bundle with injected provider", async () => {
    const res = await request(app)
      .post("/api/generate")
      .set("Authorization", `Bearer ${env.ACCESS_TOKEN}`)
      .send({
        extractedText: "Java variables store values.",
        language: "en"
      });

    expect(res.status).toBe(200);
    expect(res.body.lesson.title).toBeTypeOf("string");
    expect(Array.isArray(res.body.challenges)).toBe(true);
  });

  it("accepts upload and returns extraction payload", async () => {
    const res = await request(app)
      .post("/api/upload")
      .set("Authorization", `Bearer ${env.ACCESS_TOKEN}`)
      .attach("pdf", Buffer.from("fake"), "sample.pdf");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("usedOcrFallback");
  });
});
