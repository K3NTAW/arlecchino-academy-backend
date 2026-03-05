import { describe, expect, it } from "vitest";
import { validateChallengeQuality } from "./quality";

describe("validateChallengeQuality", () => {
  it("returns empty issues for valid content", () => {
    const issues = validateChallengeQuality({
      lesson: {
        title: "Java methods",
        summary:
          "Methods organize logic in classes and improve reuse. With parameters and return values, developers can express behavior clearly while keeping code testable, easier to maintain, and less repetitive across large projects. This also supports cleaner APIs and easier reasoning in larger object-oriented programs.",
        keyTerms: [
          { term: "method", definition: "a function in class" },
          { term: "parameter", definition: "input for method" },
          { term: "return", definition: "output from method" },
          { term: "class", definition: "blueprint for objects" },
          { term: "reuse", definition: "avoid duplication" }
        ],
        insights: [{ headline: "aha", explanation: "reuse with parameters" }],
        language: "en"
      },
      challenges: [
        {
          id: "c1",
          type: "coding",
          question: "Write method",
          starterCode: "class Main {}",
          solution: "return a + b;",
          hint: "Use return.",
          ahaInsight: "Methods can return values.",
          testCases: [{ input: "1 2", expected: "3" }]
        },
        {
          id: "m1",
          type: "mcq",
          question: "What does return do?",
          options: ["Sends value back", "Creates class", "Runs loop", "Imports package"],
          correctIndex: 0,
          explanation: "The return keyword sends the computed value back to the caller in a method.",
          whyWrongExplanations: ["Wrong", "Wrong", "Wrong"]
        }
      ]
    });
    expect(issues).toEqual([]);
  });
});
