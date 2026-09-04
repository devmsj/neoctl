export type ToolFamily = "filesystem" | "terminal" | "subagent" | "web" | "image" | "planning" | "secrets" | "plugin" | "external" | "other";
export type ToolVisibility = "primary" | "nested" | "hidden";

export interface ToolPresentation {
  family: ToolFamily;
  action: string;
  label: string;
  visibility: ToolVisibility;
}

export const BUILTIN_TOOL_NAMES = {
  fileEdit: "file_edit",
  fileWrite: "file_write",
  fileRead: "file_read",
  fileList: "file_list",
  fileSearch: "file_search",
  terminalRun: "terminal_run",
  terminalControl: "terminal_control",
  webSearch: "web_search",
  imageCreate: "image_create",
  imageInspect: "image_inspect",
  imageNote: "image_note",
  planUpdate: "plan_update",
  subagentRun: "subagent_run",
  subagentOutput: "subagent_output",
  subagentList: "subagent_list",
  subagentGet: "subagent_get",
  subagentStop: "subagent_stop",
  subagentMessage: "subagent_message",
  subagentResume: "subagent_resume",
  subagentReport: "subagent_report",
  secretList: "secret_list",
  secretInfo: "secret_info",
  secretRequest: "secret_request",
} as const;

export type BuiltinToolName = typeof BUILTIN_TOOL_NAMES[keyof typeof BUILTIN_TOOL_NAMES];

const BUILTIN_PRESENTATION: Readonly<Record<BuiltinToolName, ToolPresentation>> = {
  file_edit: { family: "filesystem", action: "edit", label: "编辑文件", visibility: "primary" },
  file_write: { family: "filesystem", action: "write", label: "写入文件", visibility: "primary" },
  file_read: { family: "filesystem", action: "read", label: "读取文件", visibility: "primary" },
  file_list: { family: "filesystem", action: "list", label: "列出文件", visibility: "primary" },
  file_search: { family: "filesystem", action: "search", label: "搜索文本", visibility: "primary" },
  terminal_run: { family: "terminal", action: "run", label: "执行命令", visibility: "primary" },
  terminal_control: { family: "terminal", action: "control", label: "终端交互", visibility: "nested" },
  web_search: { family: "web", action: "search", label: "网络搜索", visibility: "primary" },
  image_create: { family: "image", action: "create", label: "图片生成", visibility: "primary" },
  image_inspect: { family: "image", action: "inspect", label: "读取图片", visibility: "primary" },
  image_note: { family: "image", action: "note", label: "记录图片", visibility: "nested" },
  plan_update: { family: "planning", action: "update", label: "任务计划", visibility: "primary" },
  subagent_run: { family: "subagent", action: "run", label: "子任务", visibility: "primary" },
  subagent_output: { family: "subagent", action: "output", label: "读取子任务输出", visibility: "nested" },
  subagent_list: { family: "subagent", action: "list", label: "子任务列表", visibility: "hidden" },
  subagent_get: { family: "subagent", action: "get", label: "查看子任务", visibility: "hidden" },
  subagent_stop: { family: "subagent", action: "stop", label: "停止子任务", visibility: "nested" },
  subagent_message: { family: "subagent", action: "message", label: "发送子任务消息", visibility: "nested" },
  subagent_resume: { family: "subagent", action: "resume", label: "恢复子任务", visibility: "nested" },
  subagent_report: { family: "subagent", action: "report", label: "子任务报告", visibility: "hidden" },
  secret_list: { family: "secrets", action: "list", label: "密钥列表", visibility: "primary" },
  secret_info: { family: "secrets", action: "info", label: "查看密钥", visibility: "primary" },
  secret_request: { family: "secrets", action: "request", label: "申请密钥", visibility: "primary" },
};

export function builtinToolPresentation(name: string): ToolPresentation | undefined {
  return BUILTIN_PRESENTATION[name as BuiltinToolName];
}

export function toolPresentationForSource(
  name: string,
  source: "builtin" | "external" | "plugin" | "unknown" = "unknown",
): ToolPresentation {
  const builtin = builtinToolPresentation(name);
  if (builtin) return builtin;
  if (source === "plugin") return { family: "plugin", action: name, label: name, visibility: "primary" };
  if (source === "external") return { family: "external", action: name, label: name, visibility: "primary" };
  return { family: "other", action: name, label: name, visibility: "primary" };
}
