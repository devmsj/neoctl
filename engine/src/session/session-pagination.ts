import type { SessionSummary } from "./session-store.js";

export interface SessionPageOptions {
  page?: unknown;
  pageSize?: unknown;
  q?: unknown;
}

/** Shared by the regular and administrator lists. Never restores session messages. */
export function paginateSessions<T extends Pick<SessionSummary, "sessionId" | "title" | "updatedAt"> & { ownerUsername?: string; createdAt?: string }>(
  sessions: T[], options: SessionPageOptions = {},
) {
  const integer = (value: unknown, fallback: number, max: number) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 1 ? Math.min(max, Math.floor(number)) : fallback;
  };
  const pageSize = integer(options.pageSize, 10, 100);
  const query = String(options.q ?? "").trim().toLocaleLowerCase();
  const matches = sessions.filter(session => !query || [
    session.title || "未命名会话", session.sessionId, session.ownerUsername, session.updatedAt, session.createdAt,
  ].some(value => String(value ?? "").toLocaleLowerCase().includes(query)));
  matches.sort((a, b) => {
    const time = (value: T) => Date.parse(value.updatedAt || value.createdAt || "") || 0;
    return time(b) - time(a) || a.sessionId.localeCompare(b.sessionId) || (a.ownerUsername || "").localeCompare(b.ownerUsername || "");
  });
  const total = matches.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(integer(options.page, 1, Number.MAX_SAFE_INTEGER), totalPages);
  return { sessions: matches.slice((page - 1) * pageSize, page * pageSize), total, totalCount: sessions.length, page, pageSize, totalPages };
}

/** Omitted paging parameters preserve the legacy list API for older clients. */
export function sessionPageOptions(params: URLSearchParams): SessionPageOptions | undefined {
  if (!["page", "pageSize", "q"].some(key => params.has(key))) return undefined;
  return { page: params.get("page"), pageSize: params.get("pageSize"), q: params.get("q") };
}
