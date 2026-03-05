import { config as dotenvConfig } from "dotenv";
import { z } from "zod";

dotenvConfig();

const EnvSchema = z.object({
  PORT: z.coerce.number().default(3001),
  CORS_ORIGIN: z.string().url().default("http://localhost:5173"),
  DATABASE_URL: z.string().min(1),
  ACCESS_CODE: z.string().min(4).default("javafunlab"),
  ACCESS_TOKEN: z.string().min(8).default("javafunlab-token"),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().default("gemini-2.0-flash"),
  REQUEST_TIMEOUT_MS: z.coerce.number().default(20000)
});

export const env = EnvSchema.parse(process.env);
