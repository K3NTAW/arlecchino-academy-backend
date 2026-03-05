import { describe, expect, it } from "vitest";
import request from "supertest";
import { LessonBundleSchema } from "@academy/shared";
import { createApp } from "./app";
import type { AIProvider } from "./ai/provider";
import { env } from "./config";
import type { DatabaseService } from "./db";
import type { JavaEvaluator } from "./evaluator/java-evaluator";

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
  async getChallengeById(challengeId: number) {
    if (challengeId === 11) {
      return {
        id: 11,
        lessonId: 1,
        type: "coding",
        difficulty: "medium",
        payload: {
          id: "coding-1",
          type: "coding",
          question: "Read two integers and print their sum.",
          starterCode: "public class Main { public static void main(String[] args) {} }",
          solution:
            "import java.util.*; public class Main { public static void main(String[] args){ Scanner sc = new Scanner(System.in); int a=sc.nextInt(); int b=sc.nextInt(); System.out.print(a+b); } }",
          hint: "Use Scanner and print the sum.",
          ahaInsight: "The program is validated using stdin/stdout test cases.",
          testCases: [{ input: "2 2", expected: "4" }]
        }
      };
    }
    return {
      id: 10,
      lessonId: 1,
      type: "mcq",
      difficulty: "medium",
      payload: {
        id: "mcq-1",
        type: "mcq",
        question: "Which one is immutable?",
        options: ["String", "StringBuilder", "StringBuffer", "char[]"],
        correctIndex: 0,
        explanation: "String is immutable by design.",
        whyWrongExplanations: ["StringBuilder is mutable.", "StringBuffer is mutable.", "char[] is mutable."]
      }
    };
  },
  async saveAttempt() {
    return { gainedXp: 10, totalXp: 10, level: "Fledgling", streakDays: 1 };
  }
} as unknown as DatabaseService;

const fakeJavaEvaluator: JavaEvaluator = {
  async evaluate() {
    return {
      isCorrect: true,
      testResults: [{ input: "2 2", expected: "4", actual: "4", passed: true }]
    };
  }
};

const app = createApp(testProvider, fakeDb, { javaEvaluator: fakeJavaEvaluator });

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

  it("returns lesson details with full interactive challenges", async () => {
    const res = await request(app).get("/api/lessons/1").set("Authorization", `Bearer ${env.ACCESS_TOKEN}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.challenges)).toBe(true);
    expect(res.body.challenges[0]).toHaveProperty("question");
    expect(res.body.challenges[0]).toHaveProperty("options");
  });

  it("evaluates and records MCQ attempts through typed contract", async () => {
    const res = await request(app)
      .post("/api/challenges/10/attempt")
      .set("Authorization", `Bearer ${env.ACCESS_TOKEN}`)
      .send({
        type: "mcq",
        selectedIndex: 0
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.isCorrect).toBe(true);
    expect(res.body.evaluation.type).toBe("mcq");
    expect(res.body.evaluation.correctIndex).toBe(0);
  });

  it("runs coding checks without awarding XP on check intent", async () => {
    const res = await request(app)
      .post("/api/challenges/11/attempt")
      .set("Authorization", `Bearer ${env.ACCESS_TOKEN}`)
      .send({
        type: "coding",
        code: "public class Main { public static void main(String[] args){ System.out.print(4); } }",
        intent: "check"
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.intent).toBe("check");
    expect(res.body.gainedXp).toBe(0);
    expect(res.body.evaluation.type).toBe("coding");
    expect(Array.isArray(res.body.evaluation.testResults)).toBe(true);
  });
});
