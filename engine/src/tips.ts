export interface AppTip {
  id: string;
  title: string;
  placeholder: string;
  detail: string;
}

export const appTips: AppTip[] = [
  {
    id: "ask-directly",
    title: "Describe the goal directly",
    placeholder: "Tip: Type the task you want done, e.g. “summarize this project structure”",
    detail: "You can describe goals, constraints, and expected output in plain language. More specific requests usually produce better results.",
  },
  {
    id: "slash-help",
    title: "View commands",
    placeholder: "Tip: Type /help to see available commands",
    detail: "Use /help to list built-in commands and their usage.",
  },
  {
    id: "slash-completion",
    title: "Complete slash commands",
    placeholder: "Tip: Type /, use ↑/↓ to select, and Tab to complete",
    detail: "Slash commands show completions as you type. Use arrow keys to select, Tab to complete, and Enter to run.",
  },
  {
    id: "history",
    title: "Reuse previous input",
    placeholder: "Tip: Press ↑ on an empty prompt to recall previous input",
    detail: "Use ↑/↓ to browse input history so you can quickly retry or edit earlier prompts.",
  },
  {
    id: "interrupt",
    title: "Interrupt or exit",
    placeholder: "Tip: Ctrl+C clears input or interrupts work; press again on empty input to exit",
    detail: "Ctrl+C clears non-empty input, requests interruption while work is running, and exits after a second press on an empty prompt.",
  },
  {
    id: "interrupt-next",
    title: "Interrupt and send the next message",
    placeholder: "Tip: You can type while the assistant is busy; Enter interrupts it and sends the next message",
    detail: "When foreground work is running, submit another prompt to stop the current model/tool run and start the new prompt immediately. Background tasks and detached sessions keep running.",
  },
  {
    id: "paste",
    title: "Paste content",
    placeholder: "Tip: Paste text directly; long text may be folded into an attachment reference",
    detail: "Short pasted text is inserted directly. Longer pasted text can be folded into a [text_...] reference and sent with your message.",
  },
  {
    id: "image-paste",
    title: "Paste images",
    placeholder: "Tip: With vision-capable models, paste screenshots and use load_image to inspect them later as [img#1]",
    detail: "If the current model supports image input, you can paste images or screenshots from the clipboard and submit them with your prompt.",
  },
  {
    id: "sessions",
    title: "Resume sessions",
    placeholder: "Tip: Type /sessions to browse and resume saved sessions",
    detail: "Use /sessions to open saved sessions and continue working with previous context.",
  },
  {
    id: "model",
    title: "Switch models",
    placeholder: "Tip: Type /model to view or switch model and reasoning effort",
    detail: "Use /model to inspect the current model, or pass a model id and reasoning effort such as /model gpt-5 high.",
  },
  {
    id: "compact",
    title: "Compact long context",
    placeholder: "Tip: Use /compact in long sessions to compress earlier context",
    detail: "Manual compaction preserves important context while reducing pressure on the model context window.",
  },
  {
    id: "pure",
    title: "Clean up after blocks",
    placeholder: "Tip: If an upstream WAF or risk block occurs, try /pure to sanitize context",
    detail: "/pure performs a more conservative context cleanup that can help recover after upstream safety or WAF blocks.",
  },
  {
    id: "export",
    title: "Export a transcript",
    placeholder: "Tip: Type /export <absolute-path.md> to export the current transcript",
    detail: "Use /export to save the current session as Markdown for review, sharing, or archiving.",
  },
  {
    id: "cost",
    title: "Check usage",
    placeholder: "Tip: Type /cost to show token usage for this REPL session",
    detail: "/cost displays accumulated request and token usage for the current session.",
  },
  {
    id: "state",
    title: "Inspect runtime state",
    placeholder: "Tip: Type /state to inspect engine state for troubleshooting",
    detail: "/state shows query engine state and is useful when debugging configuration, context, or runtime behavior.",
  },
  {
    id: "login",
    title: "Configure providers",
    placeholder: "Tip: Type /login to configure and save a model provider",
    detail: "Use /login when setting up the app for the first time or switching provider credentials.",
  },
  {
    id: "logs",
    title: "Enable communication logs",
    placeholder: "Tip: Use /log <directory> to capture model communication logs",
    detail: "Use /log with an absolute directory to write model communication logs; use /log off to disable them.",
  },
  {
    id: "plan",
    title: "Ask for a plan",
    placeholder: "Tip: For complex work, ask the assistant to plan first and verify each step",
    detail: "For multi-step engineering tasks, ask for a short plan, incremental edits, and concrete validation at the end.",
  },
  {
    id: "constraints",
    title: "State constraints",
    placeholder: "Tip: Add constraints like “do not change public APIs” or “only edit src/web”",
    detail: "Mention scope, style, compatibility, and things to avoid up front to reduce rework.",
  },
  {
    id: "validation",
    title: "Request validation",
    placeholder: "Tip: Ask to run npm test, typecheck, or a project-specific command after changes",
    detail: "If you know the right validation command, include it in the request so the assistant can verify the work precisely.",
  },
  {
    id: "reset",
    title: "Start fresh",
    placeholder: "Tip: Type /reset to clear the current transcript without leaving the REPL",
    detail: "/reset clears the visible conversation and adds a reset marker so you can start a fresh thread in the same session.",
  },
  {
    id: "focus-files",
    title: "Point to relevant files",
    placeholder: "Tip: Mention exact files or symbols, e.g. “check src/repl/index.ts PromptLine”",
    detail: "Naming files, functions, errors, or commands helps the assistant inspect the right context first and avoid broad searches.",
  },
  {
    id: "review-diff",
    title: "Review before finishing",
    placeholder: "Tip: Ask to show or summarize the diff before wrapping up a change",
    detail: "For risky edits, ask for a diff summary or specific files changed before running validation and finalizing.",
  },
  {
    id: "current-docs",
    title: "Use current docs",
    placeholder: "Tip: For fast-moving APIs, ask the assistant to search the web before changing code",
    detail: "When behavior depends on current packages, SDKs, or service docs, request a web search so the answer is not based only on local code.",
  },
  {
    id: "parallel-investigation",
    title: "Split independent work",
    placeholder: "Tip: For independent checks, ask the assistant to investigate them in parallel",
    detail: "Independent searches, audits, or comparisons can be delegated to subagents so findings come back faster and with clearer scope.",
  },
];

export function tipAt(index: number): AppTip {
  return appTips[positiveModulo(index, appTips.length)] ?? appTips[0];
}

export function initialTipIndex(seed: string): number {
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return positiveModulo(hash, appTips.length);
}

export function formatTipLine(tip: AppTip): string {
  return `Tip: ${tip.title} — ${tip.detail}`;
}

function positiveModulo(value: number, modulo: number): number {
  return ((value % modulo) + modulo) % modulo;
}
