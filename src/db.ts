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

type DashboardStats = {
  xp: number;
  documentCount: number;
  masteryPercent: number;
  streakDays: number;
  level: string;
  recentLesson: { id: number; title: string } | null;
  recentLessons: Array<{ id: number; title: string; createdAt: string }>;
};

type ProgressStats = {
  xp: number;
  level: string;
  masteryPercent: number;
  streakDays: number;
  badges: string[];
  topics: Array<{ name: string; mastery: number }>;
  xpToNextLevel: number;
};

function levelFromXp(xp: number): string {
  if (xp >= 1500) {
    return "Harbinger";
  }
  if (xp >= 800) {
    return "Agent of the House";
  }
  if (xp >= 300) {
    return "Shadow";
  }
  if (xp >= 100) {
    return "Apprentice";
  }
  return "Fledgling";
}

function xpToNextLevel(xp: number): number {
  const thresholds = [100, 300, 800, 1500];
  const next = thresholds.find((value) => xp < value);
  return next ? next - xp : 0;
}

function badgeKeysFromXp(xp: number): string[] {
  if (xp >= 1500) {
    return ["Fledgling", "Apprentice", "Shadow", "Agent of the House", "Harbinger"];
  }
  if (xp >= 800) {
    return ["Fledgling", "Apprentice", "Shadow", "Agent of the House"];
  }
  if (xp >= 300) {
    return ["Fledgling", "Apprentice", "Shadow"];
  }
  if (xp >= 100) {
    return ["Fledgling", "Apprentice"];
  }
  return ["Fledgling"];
}

function dateOnlyUtc(value: Date): string {
  return value.toISOString().slice(0, 10);
}

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
        answer_payload JSONB,
        evaluation_payload JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      ALTER TABLE attempts
      ADD COLUMN IF NOT EXISTS answer_payload JSONB;
    `);

    await this.pool.query(`
      ALTER TABLE attempts
      ADD COLUMN IF NOT EXISTS evaluation_payload JSONB;
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS profile_progress (
        id SMALLINT PRIMARY KEY CHECK (id = 1),
        xp INT NOT NULL DEFAULT 0,
        level TEXT NOT NULL DEFAULT 'Fledgling',
        streak_days INT NOT NULL DEFAULT 0,
        last_activity_date DATE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS xp_events (
        id BIGSERIAL PRIMARY KEY,
        source TEXT NOT NULL,
        points INT NOT NULL,
        challenge_id BIGINT REFERENCES challenges(id) ON DELETE SET NULL,
        lesson_id BIGINT REFERENCES lessons(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS badge_unlocks (
        id BIGSERIAL PRIMARY KEY,
        badge_key TEXT NOT NULL UNIQUE,
        unlocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    await this.pool.query(`
      INSERT INTO profile_progress (id, xp, level, streak_days)
      VALUES (1, 0, 'Fledgling', 0)
      ON CONFLICT (id) DO NOTHING;
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

  async getDashboardStats(): Promise<DashboardStats> {
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
    const recentLessonsRes = await this.pool.query(`
      SELECT id, title, created_at
      FROM lessons
      ORDER BY created_at DESC
      LIMIT 5
    `);
    const progressRes = await this.pool.query(`
      SELECT xp, level, streak_days
      FROM profile_progress
      WHERE id = 1
      LIMIT 1
    `);

    const totalAttempts = Number(attempts.rows[0]?.total ?? 0);
    const correctAttempts = Number(attempts.rows[0]?.correct ?? 0);
    const masteryPercent = totalAttempts > 0 ? Math.round((correctAttempts / totalAttempts) * 100) : 0;
    const xp = Number(progressRes.rows[0]?.xp ?? 0);
    const level = String(progressRes.rows[0]?.level ?? levelFromXp(xp));
    const streakDays = Number(progressRes.rows[0]?.streak_days ?? 0);

    return {
      xp,
      documentCount: Number(docs.rows[0]?.count ?? 0),
      masteryPercent,
      streakDays,
      level,
      recentLesson:
        recentLessonRes.rowCount && recentLessonRes.rowCount > 0
          ? {
              id: Number(recentLessonRes.rows[0].id),
              title: recentLessonRes.rows[0].title
            }
          : null,
      recentLessons: recentLessonsRes.rows.map((row) => ({
        id: Number(row.id),
        title: String(row.title),
        createdAt: new Date(row.created_at).toISOString()
      }))
    };
  }

  async getProgressStats(): Promise<ProgressStats> {
    const dashboard = await this.getDashboardStats();
    const badgesRes = await this.pool.query(`
      SELECT badge_key
      FROM badge_unlocks
      ORDER BY unlocked_at ASC
    `);
    const badges =
      badgesRes.rowCount && badgesRes.rowCount > 0
        ? badgesRes.rows.map((row) => String(row.badge_key))
        : badgeKeysFromXp(dashboard.xp);

    return {
      xp: dashboard.xp,
      level: dashboard.level,
      masteryPercent: dashboard.masteryPercent,
      streakDays: dashboard.streakDays,
      badges,
      topics: [{ name: "Java Foundations", mastery: dashboard.masteryPercent }],
      xpToNextLevel: xpToNextLevel(dashboard.xp)
    };
  }

  async getStateSnapshot(): Promise<{
    dashboard: DashboardStats;
    progress: ProgressStats;
  }> {
    const [dashboard, progress] = await Promise.all([this.getDashboardStats(), this.getProgressStats()]);
    return { dashboard, progress };
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

  async getLessons(input: {
    page: number;
    pageSize: number;
  }): Promise<{
    items: Array<{
      id: number;
      title: string;
      language: "en" | "sr";
      createdAt: string;
      challengeCount: number;
    }>;
    total: number;
  }> {
    const offset = (input.page - 1) * input.pageSize;
    const [itemsRes, countRes] = await Promise.all([
      this.pool.query(
        `
          SELECT l.id, l.title, l.language, l.created_at, COUNT(c.id)::int AS challenge_count
          FROM lessons l
          LEFT JOIN challenges c ON c.lesson_id = l.id
          GROUP BY l.id
          ORDER BY l.created_at DESC
          LIMIT $1 OFFSET $2
        `,
        [input.pageSize, offset]
      ),
      this.pool.query(`SELECT COUNT(*)::int AS total FROM lessons`)
    ]);

    return {
      items: itemsRes.rows.map((row) => ({
        id: Number(row.id),
        title: String(row.title),
        language: row.language,
        createdAt: new Date(row.created_at).toISOString(),
        challengeCount: Number(row.challenge_count ?? 0)
      })),
      total: Number(countRes.rows[0]?.total ?? 0)
    };
  }

  async saveAttempt(
    challengeId: number,
    isCorrect: boolean,
    details?: {
      answerPayload?: unknown;
      evaluationPayload?: unknown;
    }
  ): Promise<{ gainedXp: number; totalXp: number; level: string; streakDays: number }> {
    const gainedXp = isCorrect ? 100 : 10;
    const activityDate = dateOnlyUtc(new Date());
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `
          INSERT INTO attempts (challenge_id, is_correct, answer_payload, evaluation_payload)
          VALUES ($1, $2, $3::jsonb, $4::jsonb)
        `,
        [
          challengeId,
          isCorrect,
          details?.answerPayload ? JSON.stringify(details.answerPayload) : null,
          details?.evaluationPayload ? JSON.stringify(details.evaluationPayload) : null
        ]
      );
      const progressRes = await client.query(
        `
          SELECT xp, streak_days, last_activity_date
          FROM profile_progress
          WHERE id = 1
          FOR UPDATE
        `
      );
      const currentXp = Number(progressRes.rows[0]?.xp ?? 0);
      const currentStreakDays = Number(progressRes.rows[0]?.streak_days ?? 0);
      const lastActivityDate = progressRes.rows[0]?.last_activity_date
        ? String(progressRes.rows[0].last_activity_date)
        : null;

      let nextStreakDays = currentStreakDays;
      if (!lastActivityDate) {
        nextStreakDays = 1;
      } else {
        const previousDay = new Date(`${lastActivityDate}T00:00:00.000Z`);
        const nowDay = new Date(`${activityDate}T00:00:00.000Z`);
        const diffDays = Math.round((nowDay.getTime() - previousDay.getTime()) / 86_400_000);
        if (diffDays === 0) {
          nextStreakDays = currentStreakDays;
        } else if (diffDays === 1) {
          nextStreakDays = Math.max(1, currentStreakDays + 1);
        } else {
          nextStreakDays = 1;
        }
      }

      const totalXp = currentXp + gainedXp;
      const level = levelFromXp(totalXp);
      await client.query(
        `
          UPDATE profile_progress
          SET xp = $1, level = $2, streak_days = $3, last_activity_date = $4, updated_at = NOW()
          WHERE id = 1
        `,
        [totalXp, level, nextStreakDays, activityDate]
      );

      const challengeRes = await client.query(`SELECT lesson_id FROM challenges WHERE id = $1 LIMIT 1`, [
        challengeId
      ]);
      const lessonId = challengeRes.rowCount ? Number(challengeRes.rows[0].lesson_id) : null;
      await client.query(
        `
          INSERT INTO xp_events (source, points, challenge_id, lesson_id)
          VALUES ($1, $2, $3, $4)
        `,
        [isCorrect ? "challenge.correct" : "challenge.incorrect", gainedXp, challengeId, lessonId]
      );

      for (const badgeKey of badgeKeysFromXp(totalXp)) {
        await client.query(
          `
            INSERT INTO badge_unlocks (badge_key)
            VALUES ($1)
            ON CONFLICT (badge_key) DO NOTHING
          `,
          [badgeKey]
        );
      }

      await client.query("COMMIT");
      return { gainedXp, totalXp, level, streakDays: nextStreakDays };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
