import React, { useEffect, useMemo, useState } from "react";
import { Box, Text } from "ink";
import { Lexer, type Token, type Tokens } from "marked";
import { bundledLanguages, codeToTokens, type ThemedToken } from "shiki";

const e = React.createElement;
const SHIKI_THEME = "dark-plus";

export type MarkdownLineKind = "system" | "user" | "assistant" | "thinking" | "tool" | "error" | "meta";

interface Segment {
  text: string;
  color?: string;
  backgroundColor?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dimColor?: boolean;
}

interface RenderedLine {
  segments: Segment[];
  color?: string;
}

interface AsyncRenderedLines {
  key: string;
  lines: RenderedLine[];
}

const tokenCache = new Map<string, Promise<Segment[][]>>();

export function MarkdownText({
  text,
  kind,
  width,
  maxLines,
  skipLines = 0,
}: {
  text: string;
  kind: MarkdownLineKind;
  width: number;
  maxLines?: number;
  skipLines?: number;
}) {
  const renderKey = `${kind}\0${width}\0${text}`;
  const fallbackLines = useMemo(() => renderMarkdownPreviewToLines(text, kind, width), [text, kind, width]);
  const [asyncLines, setAsyncLines] = useState<AsyncRenderedLines | undefined>();

  useEffect(() => {
    let cancelled = false;
    setAsyncLines(undefined);
    const timer = setTimeout(() => {
      void renderMarkdownToLines(text, kind, width).then((rendered) => {
        if (!cancelled) setAsyncLines({ key: renderKey, lines: rendered });
      });
    }, 40);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, kind, width, renderKey]);

  const renderedLines = clipRenderedLines(asyncLines?.key === renderKey ? asyncLines.lines : fallbackLines, maxLines, skipLines);

  return e(
    Box,
    { flexDirection: "column" },
    ...renderedLines.map((line, lineIndex) =>
      e(
        Text,
        { key: `md-line-${lineIndex}`, color: line.color ?? (kind === "meta" ? "gray" : undefined) },
        ...line.segments.map((segment, segmentIndex) =>
          e(
            Text,
            {
              key: `md-seg-${lineIndex}-${segmentIndex}`,
              color: segment.color,
              backgroundColor: segment.backgroundColor,
              bold: segment.bold,
              italic: segment.italic,
              underline: segment.underline,
              dimColor: segment.dimColor,
            },
            segment.text,
          ),
        ),
      ),
    ),
  );
}

export function estimateMarkdownLineCount(markdown: string, width: number): number {
  return renderMarkdownPreviewToLines(markdown, "assistant", width).length;
}
async function renderMarkdownToLines(markdown: string, kind: MarkdownLineKind, width: number): Promise<RenderedLine[]> {
  const normalized = normalizeIndentedFences(markdown.replace(/\r\n/g, "\n"));
  const tokens = Lexer.lex(normalized, { gfm: true });
  const lines: RenderedLine[] = [];
  const usableWidth = Math.max(10, width);

  for (const token of tokens) {
    await appendToken(lines, token, kind, usableWidth);
  }

  return lines.length ? lines : [{ segments: [{ text: "" }] }];
}

async function appendToken(lines: RenderedLine[], token: Token, kind: MarkdownLineKind, width: number): Promise<void> {
  switch (token.type) {
    case "space":
      if (lines.length > 0) lines.push({ segments: [{ text: " " }] });
      return;
    case "heading": {
      const heading = token as Tokens.Heading;
      const segments = [
        ...inlineSegments(heading.tokens, { bold: true, color: heading.depth <= 2 ? "cyan" : "blue" }),
      ];
      lines.push(...wrapSegments(segments, width).map((wrapped) => ({ segments: wrapped })));
      return;
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      appendWrapped(lines, inlineSegments(paragraph.tokens, {}), width, kind);
      return;
    }
    case "text": {
      const textToken = token as Tokens.Text;
      appendWrapped(lines, inlineSegments(textToken.tokens ?? [textToken], {}), width, kind);
      return;
    }
    case "code": {
      await appendCode(lines, token as Tokens.Code, width);
      return;
    }
    case "list": {
      await appendList(lines, token as Tokens.List, kind, width);
      return;
    }
    case "blockquote": {
      await appendBlockquote(lines, token as Tokens.Blockquote, kind, width);
      return;
    }
    case "hr":
      lines.push({ segments: [{ text: "-".repeat(Math.min(width, 80)), color: "gray" }] });
      return;
    case "table": {
      appendTable(lines, token as Tokens.Table, width);
      return;
    }
    case "html": {
      const html = token as Tokens.HTML;
      appendWrapped(lines, [{ text: html.text || html.raw, color: "gray" }], width, kind);
      return;
    }
    default: {
      const fallback = fallbackText(token);
      if (fallback) appendWrapped(lines, [{ text: fallback }], width, kind);
    }
  }
}

function renderMarkdownPreviewToLines(markdown: string, kind: MarkdownLineKind, width: number): RenderedLine[] {
  try {
    const normalized = normalizeIndentedFences(markdown.replace(/\r\n/g, "\n"));
    const tokens = Lexer.lex(normalized, { gfm: true });
    const lines: RenderedLine[] = [];
    const usableWidth = Math.max(10, width);
    for (const token of tokens) appendPreviewToken(lines, token, kind, usableWidth);
    return lines.length ? lines : [{ segments: [{ text: "" }] }];
  } catch {
    return renderPlainMarkdownPreview(markdown, kind, width);
  }
}

function renderPlainMarkdownPreview(markdown: string, kind: MarkdownLineKind, width: number): RenderedLine[] {
  const plainSegments = markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((line, index, all) => index === all.length - 1 ? [{ text: line }] : [{ text: line }, { text: "\n" }]);
  const rendered = wrapSegments(plainSegments, Math.max(10, width)).map((segments) => ({
    segments: segments.length ? segments : [{ text: "" }],
    color: kind === "error" ? "red" : undefined,
  }));
  return rendered.length ? rendered : [{ segments: [{ text: "" }] }];
}

function appendPreviewToken(lines: RenderedLine[], token: Token, kind: MarkdownLineKind, width: number): void {
  switch (token.type) {
    case "space":
      if (lines.length > 0) lines.push({ segments: [{ text: " " }] });
      return;
    case "heading": {
      const heading = token as Tokens.Heading;
      const segments = [
        ...inlineSegments(heading.tokens, { bold: true, color: heading.depth <= 2 ? "cyan" : "blue" }),
      ];
      lines.push(...wrapSegments(segments, width).map((wrapped) => ({ segments: wrapped })));
      return;
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      appendWrapped(lines, inlineSegments(paragraph.tokens, {}), width, kind);
      return;
    }
    case "text": {
      const textToken = token as Tokens.Text;
      appendWrapped(lines, inlineSegments(textToken.tokens ?? [textToken], {}), width, kind);
      return;
    }
    case "code": {
      appendCodePreview(lines, token as Tokens.Code, width);
      return;
    }
    case "list": {
      appendListPreview(lines, token as Tokens.List, kind, width);
      return;
    }
    case "blockquote": {
      appendBlockquotePreview(lines, token as Tokens.Blockquote, kind, width);
      return;
    }
    case "hr":
      lines.push({ segments: [{ text: "-".repeat(Math.min(width, 80)), color: "gray" }] });
      return;
    case "table": {
      appendTable(lines, token as Tokens.Table, width);
      return;
    }
    case "html": {
      const html = token as Tokens.HTML;
      appendWrapped(lines, [{ text: html.text || html.raw, color: "gray" }], width, kind);
      return;
    }
    default: {
      const fallback = fallbackText(token);
      if (fallback) appendWrapped(lines, [{ text: fallback }], width, kind);
    }
  }
}

function clipRenderedLines(lines: RenderedLine[], maxLines: number | undefined, skipLines = 0): RenderedLine[] {
  const start = Math.max(0, skipLines);
  if (maxLines === undefined) return lines.slice(start);
  if (maxLines <= 0) return [];
  return lines.slice(start, start + maxLines);
}

function appendWrapped(lines: RenderedLine[], segments: Segment[], width: number, kind: MarkdownLineKind): void {
  const wrapped = wrapSegments(segments, width);
  for (const line of wrapped) {
    lines.push({ segments: line, color: kind === "error" ? "red" : undefined });
  }
}

async function appendCode(lines: RenderedLine[], token: Tokens.Code, width: number): Promise<void> {
  const language = normalizeLanguage(token.lang ?? "");
  const highlighted = await highlightCode(token.text, language);
  for (const line of highlighted) {
    for (const wrapped of wrapSegments(line.length ? line : [{ text: " " }], width)) {
      lines.push({ segments: wrapped.length ? wrapped : [{ text: " " }] });
    }
  }
}
async function appendList(lines: RenderedLine[], token: Tokens.List, kind: MarkdownLineKind, width: number): Promise<void> {
  let number = typeof token.start === "number" ? token.start : 1;
  for (const item of token.items) {
    const marker = token.ordered ? `${number}. ` : "- ";
    number += 1;
    const nested: RenderedLine[] = [];
    for (const child of item.tokens) {
      await appendToken(nested, child, kind, Math.max(10, width - marker.length));
    }
    appendListItemLines(lines, marker, nested, kind);
  }
}

async function appendBlockquote(
  lines: RenderedLine[],
  token: Tokens.Blockquote,
  kind: MarkdownLineKind,
  width: number,
): Promise<void> {
  const nested: RenderedLine[] = [];
  for (const child of token.tokens) {
    await appendToken(nested, child, kind, Math.max(10, width - 2));
  }
  appendBlockquoteLines(lines, nested);
}

function appendCodePreview(lines: RenderedLine[], token: Tokens.Code, width: number): void {
  const language = normalizeLanguage(token.lang ?? "");
  const codeLines = token.text.split("\n");
  for (const [index, line] of codeLines.entries()) {
    const gutter = index === 0 && language !== "text" ? `${language} ` : "";
    for (const wrapped of wrapSegments([{ text: `${gutter}${line || " "}`, color: "gray" }], width)) {
      lines.push({ segments: wrapped.length ? wrapped : [{ text: " " }] });
    }
  }
}

function appendListPreview(lines: RenderedLine[], token: Tokens.List, kind: MarkdownLineKind, width: number): void {
  let number = typeof token.start === "number" ? token.start : 1;
  for (const item of token.items) {
    const marker = token.ordered ? `${number}. ` : "- ";
    number += 1;
    const nested: RenderedLine[] = [];
    for (const child of item.tokens) {
      appendPreviewToken(nested, child, kind, Math.max(10, width - marker.length));
    }
    appendListItemLines(lines, marker, nested, kind);
  }
}

function appendListItemLines(lines: RenderedLine[], marker: string, nested: RenderedLine[], kind: MarkdownLineKind): void {
  const itemLines = nested.length ? nested : [{ segments: [{ text: "" }] }];
  for (const [index, line] of itemLines.entries()) {
    lines.push({
      color: line.color ?? (kind === "error" ? "red" : undefined),
      segments: [{ text: index === 0 ? marker : " ".repeat(marker.length), color: "gray" }, ...line.segments],
    });
  }
}

function appendBlockquotePreview(lines: RenderedLine[], token: Tokens.Blockquote, kind: MarkdownLineKind, width: number): void {
  const nested: RenderedLine[] = [];
  for (const child of token.tokens) appendPreviewToken(nested, child, kind, Math.max(10, width - 2));
  appendBlockquoteLines(lines, nested);
}

function appendBlockquoteLines(lines: RenderedLine[], nested: RenderedLine[]): void {
  for (const line of nested) {
    lines.push({ segments: [{ text: "| ", color: "gray" }, ...line.segments] });
  }
}

function appendTable(lines: RenderedLine[], token: Tokens.Table, width: number): void {
  const renderRow = (cells: Tokens.TableCell[]) => cells.map((cell) => plainFromInline(cell.tokens)).join("  |  ");
  const rows = [renderRow(token.header), ...token.rows.map(renderRow)];
  for (const row of rows) {
    lines.push({ segments: [{ text: truncateDisplayWidth(row, width), color: "gray" }] });
  }
}

function inlineSegments(tokens: Token[], base: Omit<Segment, "text">): Segment[] {
  const segments: Segment[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "text": {
        const textToken = token as Tokens.Text;
        if (textToken.tokens?.length) segments.push(...inlineSegments(textToken.tokens, base));
        else segments.push({ ...base, text: textToken.text });
        break;
      }
      case "strong":
        segments.push(...inlineSegments((token as Tokens.Strong).tokens, { ...base, bold: true }));
        break;
      case "em":
        segments.push(...inlineSegments((token as Tokens.Em).tokens, { ...base, italic: true }));
        break;
      case "codespan":
        segments.push({ ...base, text: (token as Tokens.Codespan).text, color: "yellow" });
        break;
      case "link":
        segments.push(...inlineSegments((token as Tokens.Link).tokens, { ...base, color: "cyan", underline: true }));
        break;
      case "del":
        segments.push(...inlineSegments((token as Tokens.Del).tokens, { ...base, dimColor: true }));
        break;
      case "br":
        segments.push({ ...base, text: "\n" });
        break;
      case "escape":
        segments.push({ ...base, text: (token as Tokens.Escape).text });
        break;
      case "image":
        segments.push({ ...base, text: (token as Tokens.Image).text, color: "cyan" });
        break;
      default:
        segments.push({ ...base, text: fallbackText(token) });
    }
  }
  return mergeAdjacent(segments.filter((segment) => segment.text.length > 0));
}

function plainFromInline(tokens: Token[]): string {
  return inlineSegments(tokens, {}).map((segment) => segment.text).join("");
}

function fallbackText(token: Token): string {
  const value = token as Token & { text?: string; raw?: string };
  return value.text ?? value.raw ?? "";
}

function wrapSegments(segments: Segment[], width: number): Segment[][] {
  const lines: Segment[][] = [[]];
  let used = 0;
  const max = Math.max(1, width);

  for (const segment of segments) {
    for (const part of segment.text.split(/(\n)/u)) {
      if (part === "") continue;
      if (part === "\n") {
        lines.push([]);
        used = 0;
        continue;
      }
      for (const char of [...part]) {
        const charWidth = displayWidth(char);
        if (used > 0 && used + charWidth > max) {
          lines.push([]);
          used = 0;
        }
        const current = lines[lines.length - 1] ?? [];
        const previous = current[current.length - 1];
        if (previous && sameStyle(previous, segment)) {
          previous.text += char;
        } else {
          current.push({ ...segment, text: char });
        }
        used += charWidth;
      }
    }
  }

  return lines.length ? lines : [[{ text: "" }]];
}

function mergeAdjacent(segments: Segment[]): Segment[] {
  const merged: Segment[] = [];
  for (const segment of segments) {
    const previous = merged[merged.length - 1];
    if (previous && sameStyle(previous, segment)) previous.text += segment.text;
    else merged.push({ ...segment });
  }
  return merged;
}

function sameStyle(left: Segment, right: Segment): boolean {
  return (
    left.color === right.color &&
    left.backgroundColor === right.backgroundColor &&
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.dimColor === right.dimColor
  );
}

async function highlightCode(code: string, language: string): Promise<Segment[][]> {
  const cacheKey = `${SHIKI_THEME}\0${language}\0${code}`;
  const cached = tokenCache.get(cacheKey);
  if (cached) return cached;

  const promise = highlightCodeUncached(code, language);
  tokenCache.set(cacheKey, promise);
  const firstKey = tokenCache.keys().next().value;
  if (tokenCache.size > 200 && firstKey) tokenCache.delete(firstKey);
  return promise;
}

async function highlightCodeUncached(code: string, language: string): Promise<Segment[][]> {
  if (!code) return [[{ text: "" }]];
  if (language === "text") return code.split("\n").map((line) => [{ text: line }]);

  try {
    const result = await codeToTokens(code, {
      lang: language as never,
      theme: SHIKI_THEME,
      tokenizeMaxLineLength: 1000,
      tokenizeTimeLimit: 500,
    });
    return result.tokens.map((line) => line.map(tokenToSegment));
  } catch {
    return code.split("\n").map((line) => [{ text: line }]);
  }
}

function tokenToSegment(token: ThemedToken): Segment {
  const fontStyle = Number(token.fontStyle ?? 0);
  return {
    text: token.content,
    color: token.color,
    backgroundColor: token.bgColor,
    italic: (fontStyle & 1) !== 0,
    bold: (fontStyle & 2) !== 0,
    underline: (fontStyle & 4) !== 0,
  };
}

function normalizeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  const aliases: Record<string, string> = {
    cjs: "javascript",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    node: "javascript",
    py: "python",
    python3: "python",
    rb: "ruby",
    sh: "bash",
    shell: "bash",
    ts: "typescript",
    tsx: "tsx",
    yml: "yaml",
  };
  const lang = aliases[normalized] ?? normalized;
  if (!lang) return "text";
  return Object.prototype.hasOwnProperty.call(bundledLanguages, lang) ? lang : "text";
}

function normalizeIndentedFences(markdown: string): string {
  const lines = markdown.split("\n");
  const result: string[] = [];
  let fenceIndent: string | undefined;

  for (const line of lines) {
    if (!fenceIndent) {
      const opening = line.match(/^([ \t]{4,})(```+|~~~+)/u);
      if (opening) {
        fenceIndent = opening[1];
        result.push(line.slice(fenceIndent.length));
        continue;
      }
      result.push(line);
      continue;
    }

    const deindented = line.startsWith(fenceIndent) ? line.slice(fenceIndent.length) : line;
    result.push(deindented);
    if (/^(```+|~~~+)\s*$/u.test(deindented)) fenceIndent = undefined;
  }

  return result.join("\n");
}

function truncateDisplayWidth(value: string, maxWidth: number): string {
  if (stringDisplayWidth(value) <= maxWidth) return value;
  const ellipsis = "...";
  const limit = Math.max(0, maxWidth - stringDisplayWidth(ellipsis));
  let used = 0;
  let result = "";
  for (const char of [...value]) {
    const charWidth = displayWidth(char);
    if (used + charWidth > limit) break;
    result += char;
    used += charWidth;
  }
  return `${result}${ellipsis}`;
}

function stringDisplayWidth(value: string): number {
  let width = 0;
  for (const char of [...value]) width += displayWidth(char);
  return width;
}

function displayWidth(char: string): number {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return 0;
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombiningMark(codePoint)) return 0;
  return isFullWidthCodePoint(codePoint) ? 2 : 1;
}

function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isFullWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 && (
      codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}
