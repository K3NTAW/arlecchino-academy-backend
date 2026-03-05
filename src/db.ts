import { Pool } from "pg";

type StoredLesson = {
  id: number;
  documentId: number;
  language: "en" | "sr";
  title: string;
  summary: string;
  keyTerms: Array<{ term: string; definition: string }>;
  insights: Array<{ headline: string; explanation: string }>;
};

type StoredChallenge = {
  id: number;
  lessonId: number;
  payload: Record<string, unknown>;
  type: string;
  difficulty: string;
};

export class DatabaseService {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        id BIGSERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        content_hash TEXT NOT NULL UNIQUE,
        extracted_text TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS lessons (
        id BIGSERIAL PRIMARY KEY,
        document_id BIGINT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        language TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        key_terms JSONB NOT NULL,
        insights JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (document_id, language)
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS challenges (
        id BIGSERIAL PRIMARY KEY,
        lesson_id BIGINT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        difficulty TEXT NOT NULL DEFAULT 'medium',
        payload JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS attempts (
        id BIGSERIAL PRIMARY KEY,
        challenge_id BIGINT NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
        is_correct BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  }

  async findLessonByHashAndLanguage(hash: string, language: "en" | "sr"): Promise<{
    lesson: StoredLesson;
    challenges: StoredChallenge[];
  } | null> {
    const lessonRes = await this.pool.query(
      `
        SELECT l.id, l.document_id, l.language, l.title, l.summary, l.key_terms, l.insights
        FROM lessons l
        INNER JOIN documents d ON d.id = l.document_id
        WHERE d.content_hash = $1 AND l.language = $2
        LIMIT 1
      `,
      [hash, language]
    );

    if (lessonRes.rowCount === 0) {
      return null;
    }

    const row = lessonRes.rows[0];
    const challengeRes = await this.pool.query(
      `
        SELECT id, lesson_id, payload, type, difficulty
        FROM challenges
        WHERE lesson_id = $1
        ORDER BY id ASC
      `,
      [row.id]
    );

    return {
      lesson: {
        id: Number(row.id),
        documentId: Number(row.document_id),
        language: row.language,
        title: row.title,
        summary: row.summary,
        keyTerms: row.key_terms,
        insights: row.insights
      },
      challenges: challengeRes.rows.map((challenge) => ({
        id: Number(challenge.id),
        lessonId: Number(challenge.lesson_id),
        payload: challenge.payload,
        type: challenge.type,
        difficulty: challenge.difficulty
      }))
    };
  }

  async saveGeneratedLesson(input: {
    title: string;
    hash: string;
    extractedText: string;
    language: "en" | "sr";
    lesson: {
      title: string;
      summary: string;
      keyTerms: Array<{ term: string; definition: string }>;
      insights: Array<{ headline: string; explanation: string }>;
    };
    challenges: Array<Record<string, unknown>>;
  }): Promise<{ lessonId: number }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const documentRes = await client.query(
        `
          INSERT INTO documents (title, content_hash, extracted_text)
          VALUES ($1, $2, $3)
          ON CONFLICT (content_hash)
          DO UPDATE SET title = EXCLUDED.title
          RETURNING id
        `,
        [input.title, input.hash, input.extractedText]
      );
      const documentId = Number(documentRes.rows[0].id);

      const lessonRes = await client.query(
        `
          INSERT INTO lessons (document_id, language, title, summary, key_terms, insights)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
          ON CONFLICT (document_id, language)
          DO UPDATE SET
            title = EXCLUDED.title,
            summary = EXCLUDED.summary,
            key_terms = EXCLUDED.key_terms,
            insights = EXCLUDED.insights
          RETURNING id
        `,
        [
          documentId,
          input.language,
          input.lesson.title,
          input.lesson.summary,
          JSON.stringify(input.lesson.keyTerms),
          JSON.stringify(input.lesson.insights)
        ]
      );
      const lessonId = Number(lessonRes.rows[0].id);

      await client.query(`DELETE FROM challenges WHERE lesson_id = $1`, [lessonId]);
      for (const challenge of input.challenges) {
        const challengeType = String(challenge.type ?? "mcq");
        const difficulty = String(challenge.difficulty ?? "medium");
        await client.query(
          `
            INSERT INTO challenges (lesson_id, type, difficulty, payload)
            VALUES ($1, $2, $3, $4::jsonb)
          `,
          [lessonId, challengeType, difficulty, JSON.stringify(challenge)]
        );
      }

      await client.query("COMMIT");
      return { lessonId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getDashboardStats(): Promise<{
    xp: number;
    documentCount: number;
    masteryPercent: number;
    streakDays: number;
    level: string;
    recentLesson: { id: number; title: string } | null;
  }> {
    const docs = await this.pool.query(`SELECT COUNT(*)::int AS count FROM documents`);
    const attempts = await this.pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COALESCE(SUM(CASE WHEN is_correct THEN 1 ELSE 0 END), 0)::int AS correct
      FROM attempts
    `);
    const recentLessonRes = await this.pool.query(`
      SELECT id, title
      FROM lessons
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const totalAttempts = Number(attempts.rows[0]?.total ?? 0);
    const correctAttempts = Number(attempts.rows[0]?.correct ?? 0);
    const masteryPercent = totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0;
    const xp = correctAttempts * 100 + (totalAttempts - correctAttempts) * 10;
    const level = xp >= 500 ? "Agent of the House" : xp >= 100 ? "Apprentice" : "Fledgling";

    return {
      xp,
      documentCount: Number(docs.rows[0]?.count ?? 0),
      masteryPercent,
      streakDays: 0,
      level,
      recentLesson:
        recentLessonRes.rowCount && recentLessonRes.rowCount > 0
          ? {
              id: Number(recentLessonRes.rows[0].id),
              title: recentLessonRes.rows[0].title
            }
          : null
    };
  }

  async getLessonById(lessonId: number): Promise<{
    lesson: StoredLesson;
    challenges: StoredChallenge[];
  } | null> {
    const lessonRes = await this.pool.query(
      `
      SELECT id, document_id, language, title, summary, key_terms, insights
      FROM lessons
      WHERE id = $1
      `,
      [lessonId]
    );
    if (lessonRes.rowCount === 0) {
      return null;
    }
    const row = lessonRes.rows[0];
    const challengeRes = await this.pool.query(
      `
      SELECT id, lesson_id, payload, type, difficulty
      FROM challenges
      WHERE lesson_id = $1
      ORDER BY id ASC
      `,
      [lessonId]
    );
    return {
      lesson: {
        id: Number(row.id),
        documentId: Number(row.document_id),
        language: row.language,
        title: row.title,
        summary: row.summary,
        keyTerms: row.key_terms,
        insights: row.insights
      },
      challenges: challengeRes.rows.map((challenge) => ({
        id: Number(challenge.id),
        lessonId: Number(challenge.lesson_id),
        payload: challenge.payload,
        type: challenge.type,
        difficulty: challenge.difficulty
      }))
    };
  }

  async getChallengeById(challengeId: number): Promise<StoredChallenge | null> {
    const res = await this.pool.query(
      `SELECT id, lesson_id, payload, type, difficulty FROM challenges WHERE id = $1`,
      [challengeId]
    );
    if (res.rowCount === 0) {
      return null;
    }
    const row = res.rows[0];
    return {
      id: Number(row.id),
      lessonId: Number(row.lesson_id),
      payload: row.payload,
      type: row.type,
      difficulty: row.difficulty
    };
  }

  async saveAttempt(challengeId: number, isCorrect: boolean): Promise<void> {
    await this.pool.query(
      `INSERT INTO attempts (challenge_id, is_correct) VALUES ($1, $2)`,
      [challengeId, isCorrect]
    );
  }
}
