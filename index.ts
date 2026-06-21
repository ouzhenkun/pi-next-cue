/**
 * pi-next-cue
 *
 * Predicts your next prompt after each agent turn. Shows a hint widget above
 * the editor with two states:
 *   ↩ your last input (recall)
 *   → predicted next prompt (cue)
 *
 * Tab fills the hint into the editor; Enter sends it directly.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  CustomEditor,
  getAgentDir,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { complete, type UserMessage } from "@earendil-works/pi-ai";
import { matchesKey } from "@earendil-works/pi-tui";

const SYSTEM_PROMPT = `Predict the user's most likely next reply as one short message.

What to suggest:
- Task completed -> the next logical workflow step
- Confirmation requested -> likely yes/no/choice
- Options presented -> likely pick, if context supports one
- Open-ended question -> a concrete answer or direction, only if inferable
- Tool failed -> a specific retry/fix based on the failure
- Tool succeeded -> the next useful step
- Agent proposed a clear next action -> a short affirmation is often enough
- If context is too thin to predict a useful reply, return [skip]

Tone:
- Match the language and register of recent user messages
- Casual when the moment is casual, direct when there is momentum
- Do not force excitement, praise, or drama

Rules:
- Return ONE message, under 60 chars, nothing else
- If no useful suggestion exists, return exactly: [skip]
- The suggestion must advance or unblock the workflow
- A short confirmation counts as advancing when it lets the agent proceed
- Be specific to this conversation, not generic
- Never repeat or rephrase the assistant's last message
- Never suggest an action the assistant already completed
- If the assistant only offered a pending action, a brief confirmation is allowed
- Learn from user corrections in the conversation; avoid rejected directions
- If a slash command is the obvious next action, suggest only the command
- Never output a generic question like "what's next" or "what should I do" — return [skip] instead`;

const SKIP_TOKEN = "[skip]";
const MAX_CORRECTIONS = 5;

type HintType = "recall" | "cue";

export default function (pi: ExtensionAPI) {
  let currentHint: string | null = null;
  let hintType: HintType | null = null;
  let widgetCtx: any = null;
  let suggestionAbort: AbortController | null = null;

  // Correction tracking
  const corrections: Array<{ suggested: string; actual: string }> = [];
  let lastSuggestion: string | null = null;

  // Tool outcome tracking
  let lastToolOutcome: { tool: string; ok: boolean; tail: string } | null =
    null;

  function setHint(text: string | null, type: HintType | null) {
    currentHint = text;
    hintType = type;
    if (!widgetCtx || paused) return;
    if (!text) {
      widgetCtx.ui.setWidget("hint", undefined);
      return;
    }
    const icon = type === "recall" ? "↩" : "→";
    const display = text.length > 80 ? text.slice(0, 77) + "..." : text;
    widgetCtx.ui.setWidget("hint", [
      `\x1b[38;5;240m${icon} ${display.replace(/\n/g, " ")}\x1b[0m`,
    ]);
  }

  // Pause/resume hint visibility (for dialogs, overlays, etc.)
  let paused = false;

  function pauseHint() {
    paused = true;
    if (widgetCtx) widgetCtx.ui.setWidget("hint", undefined);
  }

  function resumeHint() {
    paused = false;
    if (currentHint) setHint(currentHint, hintType);
  }

  pi.events.on("pi-next-cue:pause", pauseHint);
  pi.events.on("pi-next-cue:resume", resumeHint);

  // Load config from ~/.pi/agent/pi-next-cue.json
  let userConfig: { provider?: string; model?: string; keys?: { fill?: string; send?: string } } = {};
  try {
    const configPath = path.join(getAgentDir(), "pi-next-cue.json");
    const raw = fs.readFileSync(configPath, "utf-8");
    userConfig = JSON.parse(raw);
  } catch {
    // No config file — use defaults
  }

  const fillKey = userConfig.keys?.fill || "tab";
  const sendKey = userConfig.keys?.send || "enter";

  /**
   * Resolve the model to use for suggestion generation.
   * Tries user config first, then falls back to session default.
   */
  function resolveModel(ctx: any) {
    if (userConfig.provider && userConfig.model) {
      const found = ctx.modelRegistry.find(userConfig.provider, userConfig.model);
      if (found) return found;
    }
    return ctx.model;
  }

  async function generateSuggestion(ctx: any) {
    if (suggestionAbort) {
      suggestionAbort.abort();
      suggestionAbort = null;
    }

    const model = resolveModel(ctx);
    if (!model) return;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) return;

    // Gather recent messages for context
    const branch = ctx.sessionManager.getBranch();
    const recentMessages: Array<{ role: string; text: string }> = [];
    const recentTools: string[] = [];

    for (let i = branch.length - 1; i >= 0 && recentMessages.length < 6; i--) {
      const entry = branch[i];
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (!("role" in msg)) continue;

      if (msg.role === "toolResult" && recentTools.length < 5) {
        const toolName = msg.toolName || "unknown";
        if (!recentTools.includes(toolName)) recentTools.push(toolName);
        continue;
      }

      if (msg.role !== "user" && msg.role !== "assistant") continue;

      const textParts = msg.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("\n");

      if (textParts.trim()) {
        const maxLen = msg.role === "assistant" ? 1000 : 500;
        const text =
          msg.role === "assistant" && textParts.length > maxLen
            ? "..." + textParts.slice(-maxLen)
            : textParts.slice(0, maxLen);
        recentMessages.unshift({ role: msg.role, text });
      }
    }

    if (recentMessages.length === 0) return;

    // Build context
    const parts: string[] = [];

    if (corrections.length > 0) {
      const corrLines = corrections
        .slice(-3)
        .map((c) => `- suggested "${c.suggested}" → user typed "${c.actual}"`)
        .join("\n");
      parts.push(`[Corrections]\n${corrLines}`);
    }

    if (lastToolOutcome) {
      const status = lastToolOutcome.ok ? "✓" : "✗";
      parts.push(
        `[Last Tool] ${status} ${lastToolOutcome.tool}: ${lastToolOutcome.tail}`,
      );
    }

    if (recentTools.length > 0) {
      parts.push(`[Tools Used] ${recentTools.join(", ")}`);
    }

    const contextLines = recentMessages.map((m, i) => {
      const prefix = m.role === "user" ? "User" : "Assistant";
      const isLast = i === recentMessages.length - 1;
      return isLast ? `[LATEST] ${prefix}: ${m.text}` : `${prefix}: ${m.text}`;
    });
    parts.push(contextLines.join("\n\n"));

    const userMessage: UserMessage = {
      role: "user",
      content: [{ type: "text", text: parts.join("\n\n") }],
      timestamp: Date.now(),
    };

    const abort = new AbortController();
    suggestionAbort = abort;

    try {
      const response = await complete(
        model,
        { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
        {
          apiKey: auth.apiKey,
          headers: auth.headers,
          signal: abort.signal,
          maxTokens: 40,
          onPayload: (payload: any) => {
            // Disable thinking for models that support it (e.g. DeepSeek)
            payload.thinking = { type: "disabled" };
            return payload;
          },
        },
      );

      if (response.stopReason === "aborted") return;

      const suggestion = response.content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
        .join("")
        .trim()
        .replace(/^["'`]|["'`]$/g, "")
        .slice(0, 60);

      if (suggestion && suggestion !== SKIP_TOKEN && !abort.signal.aborted) {
        setHint(suggestion, "cue");
        lastSuggestion = suggestion;
      }
    } catch {
      // Suggestion is optional — fail silently
    } finally {
      if (suggestionAbort === abort) suggestionAbort = null;
    }
  }

  // Track tool outcomes
  pi.on("tool_execution_end", async (event: any) => {
    const content =
      typeof event.result === "string"
        ? event.result
        : Array.isArray(event.result)
          ? event.result
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("")
          : "";
    const tail =
      content.length > 150 ? "..." + content.slice(-150) : content;
    lastToolOutcome = {
      tool: event.toolName || "unknown",
      ok: !event.isError,
      tail: tail.replace(/\n/g, " ").slice(0, 150),
    };
  });

  // Track user messages → show ↩ hint + record corrections
  pi.on("message_end", async (event) => {
    if (event.message.role === "user") {
      if (suggestionAbort) {
        suggestionAbort.abort();
        suggestionAbort = null;
      }

      const content = event.message.content;
      if (!Array.isArray(content)) return;
      const text = content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("");

      if (text.trim() && lastSuggestion && text.trim() !== lastSuggestion) {
        corrections.push({ suggested: lastSuggestion, actual: text.trim() });
        if (corrections.length > MAX_CORRECTIONS) corrections.shift();
      }
      lastSuggestion = null;

      if (text.trim()) setHint(text, "recall");
    }
  });

  // Generate suggestion after agent completes
  pi.on("agent_end", async (event: any, ctx) => {
    if (event.willRetry || !event.messages?.length) return;

    const lastAssistant = [...event.messages]
      .reverse()
      .find((m: any) => m.role === "assistant");
    if (!lastAssistant) return;

    const hasText = lastAssistant.content?.some(
      (b: any) => b.type === "text" && b.text?.trim(),
    );
    if (!hasText) return;

    generateSuggestion(ctx);
  });

  pi.on("session_start", async (event: any, ctx) => {
    if (ctx.mode !== "tui") return;
    widgetCtx = ctx;

    if (event.reason === "reload") {
      generateSuggestion(ctx);
    }

    // Extend editor: Tab fills hint, Enter sends it
    const prevFactory = ctx.ui.getEditorComponent();

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const base = prevFactory
        ? prevFactory(tui, theme, keybindings)
        : new CustomEditor(tui, theme, keybindings);

      const originalHandleInput = base.handleInput.bind(base);

      base.handleInput = (data: string) => {
        const text = base.getText();
        const isEmpty = !text || text.trim() === "";

        if (isEmpty && currentHint) {
          if (matchesKey(data, fillKey)) {
            base.setText(currentHint);
            return;
          }
          if (matchesKey(data, sendKey)) {
            const hint = currentHint;
            setHint(null, null);
            pi.sendUserMessage(hint);
            return;
          }
        }

        originalHandleInput(data);
      };

      return base;
    });
  });
}
