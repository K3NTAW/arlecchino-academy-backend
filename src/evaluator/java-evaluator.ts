import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { CodingTestResult } from "@academy/shared";

export type JavaEvaluationInput = {
  code: string;
  testCases: Array<{ input: string; expected: string }>;
};

export type JavaEvaluationResult = {
  isCorrect: boolean;
  testResults: CodingTestResult[];
};

export interface JavaEvaluator {
  evaluate(input: JavaEvaluationInput): Promise<JavaEvaluationResult>;
}

type CommandResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

async function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  stdin?: string;
}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: "pipe"
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });

    if (input.stdin) {
      child.stdin.write(input.stdin);
    }
    child.stdin.end();
  });
}

function normalizeOutput(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

export class LocalJavaEvaluator implements JavaEvaluator {
  async evaluate(input: JavaEvaluationInput): Promise<JavaEvaluationResult> {
    const workdir = await mkdtemp(join(tmpdir(), "academy-java-"));

    try {
      await writeFile(join(workdir, "Main.java"), input.code, "utf8");

      const compile = await runCommand({
        command: "javac",
        args: ["Main.java"],
        cwd: workdir,
        timeoutMs: 8000
      });

      if (compile.timedOut || compile.code !== 0) {
        const reason = compile.timedOut
          ? "Compilation timed out."
          : normalizeOutput(compile.stderr) || "Compilation failed.";
        return {
          isCorrect: false,
          testResults: input.testCases.map((testCase) => ({
            input: testCase.input,
            expected: testCase.expected,
            actual: "",
            passed: false,
            error: reason
          }))
        };
      }

      const results: CodingTestResult[] = [];
      for (const testCase of input.testCases) {
        const execute = await runCommand({
          command: "java",
          args: ["-cp", workdir, "Main"],
          cwd: workdir,
          timeoutMs: 5000,
          stdin: testCase.input
        });

        const actual = normalizeOutput(execute.stdout);
        const expected = normalizeOutput(testCase.expected);
        const runtimeError =
          execute.timedOut || execute.code !== 0
            ? execute.timedOut
              ? "Execution timed out."
              : normalizeOutput(execute.stderr) || "Execution failed."
            : undefined;
        const passed = !runtimeError && actual === expected;

        results.push({
          input: testCase.input,
          expected: testCase.expected,
          actual,
          passed,
          error: runtimeError
        });
      }

      return {
        isCorrect: results.every((result) => result.passed),
        testResults: results
      };
    } finally {
      await rm(workdir, { recursive: true, force: true });
    }
  }
}

