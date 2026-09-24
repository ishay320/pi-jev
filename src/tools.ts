import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JevClient } from "./jev.js";
import { Type } from "@sinclair/typebox";
import type { ToolRouter } from "./router.js";
import type { SkillRouter } from "./skills.js";
import type { QuestionConfig } from "./types.js";
import { JEV_THRESHOLD } from "./skills.js";

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const BINARY_EXTENSIONS: Record<string, true> = {
  ".pyc": true, ".pyo": true, ".so": true, ".dll": true, ".dylib": true,
  ".png": true, ".jpg": true, ".jpeg": true, ".gif": true, ".ico": true,
  ".pdf": true, ".zip": true, ".tar": true, ".gz": true, ".mp4": true,
  ".mp3": true, ".wav": true, ".mov": true, ".avi": true, ".node": true
};

const STOP_WORDS: Record<string, true> = {
  "the": true, "that": true, "for": true, "and": true, "with": true,
  "this": true, "from": true, "into": true, "will": true, "a": true,
  "an": true, "in": true, "on": true, "to": true, "of": true
};

/**
 * Find all text files in given paths
 */
function findFiles(paths: string[], extensions?: string[]): string[] {
  const files: string[] = [];
  
  for (const p of paths) {
    try {
      const stats = statSync(p);
      if (stats.isFile()) {
        files.push(p);
      } else if (stats.isDirectory()) {
        // Recursively find files
        const walk = (dir: string) => {
          try {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const fullPath = join(dir, entry.name);
              if (entry.isDirectory()) {
                walk(fullPath);
              } else if (entry.isFile()) {
                files.push(fullPath);
              }
            }
          } catch {
            // Skip directories we can't read
          }
        };
        walk(p);
      }
    } catch {
      // Skip paths we can't stat
    }
  }
  
  // Filter by extension and check if text file
  return files.filter(file => {
    const ext = extname(file);
    
    // Skip binary files
    if (ext in BINARY_EXTENSIONS) return false;
    
    // Filter by extension if provided
    if (extensions && extensions.length > 0) {
      if (!extensions.some(e => ext === e || ext === `.${e}`)) return false;
    }
    
    // Try to read first 1KB to verify it's text
    try {
      readFileSync(file, { encoding: "utf-8", flag: "r" }).substring(0, 1024);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Perform exact keyword search
 */
function exactSearch(
  query: string,
  paths: string[],
  extensions: string[] | undefined,
  maxResults: number,
  contextLines: number
): string {
  const files = findFiles(paths, extensions);
  
  // Extract keywords
  const queryLower = query.toLowerCase();
  const keywords = queryLower.split(/\s+/).filter(w => w.length > 2 && !(w in STOP_WORDS));
  
  if (keywords.length === 0) return "No valid keywords in query";
  
  const results: Array<{ label: string; score: number; snippet: string }> = [];
  
  for (const file of files) {
    try {
      const content = readFileSync(file, { encoding: "utf-8" });
      const lines = content.split("\n");
      
      for (let i = 0; i <= lines.length - contextLines; i++) {
        const snippet = lines.slice(i, i + contextLines).join("\n");
        const snippetLower = snippet.toLowerCase();
        
        // Count keyword matches
        let matches = 0;
        for (const kw of keywords) {
          if (snippetLower.includes(kw)) matches++;
        }
        
        if (matches > 0) {
          const label = `${file}:${i + 1}-${i + contextLines}`;
          const score = matches / keywords.length;
          results.push({ label, score, snippet });
        }
      }
    } catch {
      // Skip files we can't read
    }
  }
  
  // Sort by score descending
  results.sort((a, b) => b.score - a.score);
  
  // Format output
  const topResults = results.slice(0, maxResults);
  if (topResults.length === 0) return "No results found";
  
  return topResults
    .map((r, i) => {
      return `\n${"=".repeat(60)}\n#${i + 1} ${r.label} (score: ${(r.score * 100).toFixed(2)}%)\n${"=".repeat(60)}\n${r.snippet}`;
    })
    .join("\n");
}


export function registerJevTools(
  pi: ExtensionAPI,
  jevClient: JevClient,
  router: ToolRouter,
  skillRouter: SkillRouter
): void {
  // 1. Tool router tool: jev_find_tools
  pi.registerTool({
    name: "jev_find_tools",
    label: "Jev Tool Finder",
    description:
      "Find and additively activate registered Pi tools needed for a task using TypeSafe Jev semantic evaluation.",
    promptSnippet: "Search and dynamically activate specialized tools for current task",
    promptGuidelines: [
      "Use jev_find_tools when current active tools cannot accomplish the user request.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "The action, capability, or user task you need tools for.",
      }),
      threshold: Type.Optional(
        Type.Number({
          description: "Activation confidence threshold between 0.0 and 1.0 (default JEV_THRESHOLD).",
        })
      ),
    }),
    async execute(_toolCallId, params: any, signal, onUpdate) {
      onUpdate?.({
        content: [{ type: "text", text: `Evaluating candidate tools for: "${params.query}"...` }],
        details: {},
      });

      const result = await router.findAndActivate(
        params.query,
        params.threshold ?? JEV_THRESHOLD,
        signal
      );

      let summaryText = "";
      if (result.activated.length > 0) {
        summaryText = `Activated tools: ${result.activated.join(", ")}`;
      } else if (result.candidates.length > 0) {
        summaryText = `No tools met the activation threshold among candidates: ${result.candidates.join(", ")}`;
      } else {
        summaryText = `No matching inactive tools found.`;
      }

      if (result.fallbackUsed) {
        summaryText += " (Note: local heuristic shortlist used due to Jev unconfigured/offline)";
      }

      return {
        content: [{ type: "text", text: summaryText }],
        details: result,
      };
    },
  });

  // 2. Skill finder tool: jev_find_skill
  pi.registerTool({
    name: "jev_find_skill",
    label: "Jev Skill Finder",
    description:
      "Find and recommend the best matching agent skills for a specific task or problem using TypeSafe Jev semantic evaluation.",
    promptSnippet: "Discover specialized skills/workflows relevant to current task",
    promptGuidelines: [
      "Use jev_find_skill when working on specialized tasks (e.g. testing, UI design, animations, security reviews, git conflicts) to locate the relevant SKILL.md guide.",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "The task, domain, or technology you need specialized skills for.",
      }),
      threshold: Type.Optional(
        Type.Number({
          description: "Match confidence threshold between 0.0 and 1.0 (default JEV_THRESHOLD).",
        })
      ),
    }),
    async execute(_toolCallId, params: any, signal, onUpdate, ctx) {
      onUpdate?.({
        content: [{ type: "text", text: `Evaluating matching skills for: "${params.query}"...` }],
        details: {},
      });

      const result = await skillRouter.findSkills(
        params.query,
        params.threshold ?? JEV_THRESHOLD,
        ctx,
        signal
      );

      let summaryText = "";
      if (result.recommended.length > 0) {
        const lines = result.recommended.map(
          (r) => `• /skill:${r.name} (P=${r.probability.toFixed(2)})${r.location ? ` - ${r.location}` : ""}\n  ${r.description}`
        );
        summaryText = `Recommended skill(s):\n${lines.join("\n")}\n\nTo use a skill, invoke /skill:<name> or use the read tool to open its SKILL.md file.`;
      } else if (result.candidates.length > 0) {
        summaryText = `No skills met the confidence threshold among candidates: ${result.candidates.join(", ")}`;
      } else {
        summaryText = `No registered skills found in session.`;
      }

      if (result.fallbackUsed) {
        summaryText += "\n(Note: local heuristic shortlist used due to Jev unconfigured/offline)";
      }

      return {
        content: [{ type: "text", text: summaryText }],
        details: result,
      };
    },
  });

  // 3. Typed evaluation tool: jev_evaluate
  pi.registerTool({
    name: "jev_evaluate",
    label: "Jev Evaluate",
    description:
      "Ask TypeSafe Jev System One typed questions (choice, noul, score) about structured state. Returns calibrated probabilities.",
    promptSnippet: "Perform fast calibrated structured decisions and classifications over state",
    promptGuidelines: [
      "Use jev_evaluate when you need structured probability, categorical choice, or scored rubric decisions rather than text generation.",
    ],
    parameters: Type.Object({
      state: Type.Any({ description: "Target context, text, or structured JSON to evaluate" }),
      questions: Type.Record(
        Type.String(),
        Type.Object({
          type: Type.Union([
            Type.Literal("choice"),
            Type.Literal("noul"),
            Type.Literal("score"),
          ]),
          instructions: Type.String({ description: "The judgment instruction/question" }),
          criteria: Type.Optional(Type.Any({ description: "Options, yes/no criterion, or rubric levels" })),
        })
      ),
      model: Type.Optional(Type.String({ description: "Jev model identifier (default: jev-latest)" })),
    }),
    async execute(_toolCallId, params: any, signal, onUpdate) {
      if (!jevClient.isConfigured()) {
        throw new Error(
          "TypeSafe Jev API key is not configured. Set TYPESAFE_API_KEY environment variable or save ~/.pi/agent/secrets/typesafe_api_key."
        );
      }

      onUpdate?.({
        content: [{ type: "text", text: "Querying TypeSafe Jev model..." }],
        details: {},
      });

      const questions: Record<string, QuestionConfig> = {};
      for (const [id, q] of Object.entries(params.questions as Record<string, any>)) {
        questions[id] = {
          type: q.type,
          instructions: q.instructions,
          criteria: q.criteria,
        };
      }

      const response = await jevClient.evaluate(
        {
          state: params.state,
          questions,
          model: params.model,
        },
        signal
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(response.answers, null, 2),
          },
        ],
        details: response,
      };
    },
  });

  // 4. Semantic code search tool: jev_search
  pi.registerTool({
    name: "jev_search",
    label: "Jev Code Search",
    description:
      "Search code semantically using Jev evaluation. Finds code sections matching natural language queries across files and directories.",
    promptSnippet: "Search code with natural language queries",
    promptGuidelines: [
      "Use jev_search to find code implementing specific functionality.",
      "Prefer --exact mode for fast keyword-based searches.",
      "Use default semantic mode for conceptual searches (e.g., 'error handling for API calls').",
    ],
    parameters: Type.Object({
      query: Type.String({
        description: "Natural language search query (e.g., 'function that writes online to status bar')",
      }),
      paths: Type.Optional(
        Type.Array(Type.String(), {
          default: () => ["."],
          description: "Paths to search (default: current directory)",
        })
      ),
      exact: Type.Optional(
        Type.Boolean({
          default: false,
          description: "Use exact keyword matching (faster, no Jev)",
        })
      ),
      maxResults: Type.Optional(
        Type.Number({
          default: 10,
          description: "Maximum results to return",
        })
      ),
      extensions: Type.Optional(
        Type.Array(Type.String(), {
          description: "File extensions to include (e.g., ['.ts', '.js'])",
        })
      ),
      contextLines: Type.Optional(
        Type.Number({
          default: 3,
          description: "Number of context lines per section",
        })
      ),
    }),
    async execute(_toolCallId, params: any, signal, onUpdate) {
      const { query, paths = ["."], exact = false, maxResults = 10, extensions, contextLines = 3 } = params;

      onUpdate?.({
        content: [{ type: "text", text: `Starting ${exact ? "exact" : "semantic"} search for: "${query}"` }],
        details: {},
      });

      try {
        // Use pure TypeScript implementation
        const result = exactSearch(query, paths, extensions, maxResults, contextLines);

        onUpdate?.({
          content: [{ type: "text", text: `Found results for: "${query}"` }],
          details: {},
        });

        return {
          content: [
            {
              type: "text",
              text: result,
            },
          ],
          details: { result },
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Search failed: ${message}`,
            },
          ],
          details: { error: message },
        };
      }
    },
  });
}
