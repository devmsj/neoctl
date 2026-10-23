// Static SVG authored for the tool history design. Never accepts tool-supplied markup.
export const toolIcons = {
  "thinking": {
    "name": "思考",
    "body": "<path d=\"M14 6a4 4 0 0 0-7-2.2 4.4 4.4 0 0 0-3.2 6.8 4.8 4.8 0 0 0 .7 8.4A4.6 4.6 0 0 0 14 22V6Z M14 6a4 4 0 0 1 7-2.2 4.4 4.4 0 0 1 3.2 6.8 4.8 4.8 0 0 1-.7 8.4A4.6 4.6 0 0 1 14 22\"/><path d=\"M7 9a4 4 0 0 1 4 4v2 M5 18a4 4 0 0 0 4-4 M9 21v-2\" class=\"motion thought\"/><path d=\"M21 9a4 4 0 0 0-4 4v2 M23 18a4 4 0 0 1-4-4 M19 21v-2\" class=\"motion thought thought-next\"/>"
  },
  "file_read": {
    "name": "读取文件",
    "body": "<path d=\"M6 3h11l5 5v17H6z M17 3v5h5\" /><path d=\"M10 12h8\" class=\"motion reveal\" /><path d=\"M10 16h8\" class=\"motion reveal delay1\" /><path d=\"M10 20h5\" class=\"motion reveal delay2\" />"
  },
  "file_list": {
    "name": "列出文件",
    "body": "<path d=\"M3 8V5h8l3 3h11v16H3z\" /><path d=\"M7 12h3 M13 12h8\" class=\"motion reveal\" /><path d=\"M7 16h3 M13 16h8\" class=\"motion reveal delay1\" /><path d=\"M7 20h3 M13 20h6\" class=\"motion reveal delay2\" />"
  },
  "file_search": {
    "name": "搜索文本",
    "body": "<path d=\"M3 6h10 M3 11h7 M3 16h9 M3 21h6\" opacity=\".45\"/><g class=\"motion scan\"><circle cx=\"15\" cy=\"12\" r=\"5.5\" /><path d=\"m19 16 5 5\" /></g>"
  },
  "file_write": {
    "name": "写入文件",
    "body": "<path d=\"M6 3h11l5 5v17H6z M17 3v5h5\" /><path d=\"M10 13h8 M10 17h8 M10 21h5\" class=\"motion draw\" /><g class=\"motion down\"><path d=\"M12 2v7 m-3-3 3 3 3-3\" /></g>"
  },
  "file_edit": {
    "name": "编辑文件",
    "body": "<path d=\"M4 24h20\" opacity=\".45\"/><path d=\"M5 21h13\" class=\"motion ink\" /><g class=\"motion write\"><path d=\"m10 17 10-12a1.7 1.7 0 0 1 2.4-.2l1.3 1.1a1.7 1.7 0 0 1 .2 2.4l-10 12-5 .8z M18.5 6.8l4 3.4 M10 17l3.9 3.3\" /></g>"
  },
  "terminal_run": {
    "name": "执行命令",
    "body": "<rect x=\"3\" y=\"5\" width=\"22\" height=\"19\" rx=\"1.5\" /><path d=\"M3 9h22\" /><path d=\"m7 13 3 3-3 3\" /><path d=\"M13 19h7\" class=\"motion type\" /><path d=\"M21 15v5\" class=\"motion blink\" />"
  },
  "terminal_control": {
    "name": "终端交互",
    "body": "<rect x=\"3\" y=\"5\" width=\"22\" height=\"19\" rx=\"1.5\" /><path d=\"M3 9h22\" /><g class=\"motion exchange\"><path d=\"M7 14h12 m-3-3 3 3-3 3\" /></g><g class=\"motion exchange reverse\"><path d=\"M21 20H9 m3-3-3 3 3 3\" /></g>"
  },
  "web_search": {
    "name": "网络搜索",
    "body": "<circle cx=\"12\" cy=\"12\" r=\"9\" /><path d=\"M3 12h18 M12 3c-6 5-6 13 0 18 M12 3c6 5 6 13 0 18\" opacity=\".45\"/><g class=\"motion scan\"><circle cx=\"20\" cy=\"19\" r=\"4.5\" /><path d=\"m23 22 3 3\" /></g>"
  },
  "image_create": {
    "name": "图片生成",
    "body": "<rect x=\"3\" y=\"4\" width=\"22\" height=\"20\" rx=\"1.5\" /><circle cx=\"9\" cy=\"10\" r=\"2\" /><path d=\"m4 21 7-7 5 5 4-5 5 7\" class=\"motion draw\" /><g class=\"motion brush\"><path d=\"m17 13 6-8 2 2-6 8-3 1z\" /></g>"
  },
  "image_inspect": {
    "name": "读取图片",
    "body": "<rect x=\"3\" y=\"4\" width=\"22\" height=\"20\" rx=\"1.5\" /><circle cx=\"9\" cy=\"10\" r=\"2\" /><path d=\"m4 21 7-7 5 5 4-5 5 7\" /><g class=\"motion scan\"><circle cx=\"20\" cy=\"19\" r=\"4.5\" /><path d=\"m23 22 3 3\" /></g>"
  },
  "image_note": {
    "name": "记录图片",
    "body": "<rect x=\"3\" y=\"4\" width=\"15\" height=\"18\" rx=\"1.5\" /><circle cx=\"8\" cy=\"9\" r=\"1.5\" /><path d=\"m4 19 5-6 6 6\" /><rect x=\"14\" y=\"14\" width=\"11\" height=\"11\" rx=\"1.5\" /><path d=\"M17 18h5 M17 21h4\" class=\"motion draw\" />"
  },
  "plan_update": {
    "name": "任务计划",
    "body": "<rect x=\"5\" y=\"5\" width=\"19\" height=\"20\" rx=\"1.5\" /><rect x=\"10\" y=\"3\" width=\"9\" height=\"4\" rx=\"1.5\" /><path d=\"M9 11h2 M14 11h6 M9 16h2 M14 16h6 M9 21h2 M14 21h6\" class=\"motion reveal\" /><path d=\"m8 15 2 2 3-4\" class=\"motion tick\" />"
  },
  "framework_feedback": {
    "name": "框架改进建议",
    "body": "<path d=\"M4 4h20v15H12l-6 5v-5H4z\" /><g class=\"motion idea\"><path d=\"M11 12a4 4 0 1 1 6 0l-1 2h-4z M12 16h4\" /></g>"
  },
  "subagent_run": {
    "name": "子任务",
    "body": "<rect x=\"2\" y=\"10\" width=\"7\" height=\"7\" rx=\"1.5\" /><path d=\"M9 14h6V6h5\" class=\"motion route\" /><path d=\"M9 14h6v8h5\" class=\"motion route delay1\" /><rect x=\"20\" y=\"3\" width=\"6\" height=\"6\" rx=\"1.5\" /><rect x=\"20\" y=\"19\" width=\"6\" height=\"6\" rx=\"1.5\" />"
  },
  "subagent_output": {
    "name": "读取子任务输出",
    "body": "<rect x=\"5\" y=\"5\" width=\"18\" height=\"19\" rx=\"1.5\" /><path d=\"M10 5V3h8v2 M9 10h10\" /><path d=\"M9 14h9 M9 18h6\" class=\"motion reveal\" /><g class=\"motion down\"><path d=\"M19 16v9 m-3-3 3 3 3-3\" /></g>"
  },
  "subagent_list": {
    "name": "子任务列表",
    "body": "<rect x=\"3\" y=\"4\" width=\"5\" height=\"5\" rx=\"1.5\" /><rect x=\"3\" y=\"12\" width=\"5\" height=\"5\" rx=\"1.5\" /><rect x=\"3\" y=\"20\" width=\"5\" height=\"5\" rx=\"1.5\" /><path d=\"M12 6h12\" class=\"motion reveal\" /><path d=\"M12 14h12\" class=\"motion reveal delay1\" /><path d=\"M12 22h9\" class=\"motion reveal delay2\" />"
  },
  "subagent_get": {
    "name": "查看子任务",
    "body": "<rect x=\"5\" y=\"5\" width=\"18\" height=\"19\" rx=\"1.5\" /><path d=\"M10 5V3h8v2 M9 10h10\" /><path d=\"M9 14h7 M9 18h5\" opacity=\".45\"/><g class=\"motion scan\"><circle cx=\"20\" cy=\"19\" r=\"4.5\" /><path d=\"m23 22 3 3\" /></g>"
  },
  "subagent_stop": {
    "name": "停止子任务",
    "body": "<rect x=\"5\" y=\"5\" width=\"18\" height=\"19\" rx=\"1.5\" /><path d=\"M10 5V3h8v2 M9 10h10\" /><g class=\"motion halt\"><rect x=\"10\" y=\"13\" width=\"8\" height=\"7\" rx=\"1.5\" /></g>"
  },
  "subagent_message": {
    "name": "发送子任务消息",
    "body": "<path d=\"M3 8h17v15H3z M3 9l8.5 7L20 9\" /><g class=\"motion send\"><path d=\"m13 5 12-3-3 12-3-6z M19 8l6-6\" /></g>"
  },
  "subagent_resume": {
    "name": "恢复子任务",
    "body": "<rect x=\"5\" y=\"5\" width=\"18\" height=\"19\" rx=\"1.5\" /><path d=\"M10 5V3h8v2 M9 10h10\" /><g class=\"motion forward\"><path d=\"m11 13 7 4-7 4z\" /></g>"
  },
  "subagent_report": {
    "name": "子任务报告",
    "body": "<path d=\"M6 3h11l5 5v17H6z M17 3v5h5\" /><path d=\"M9 21h10\" /><path d=\"M10 18v-3\" class=\"motion grow\" /><path d=\"M14 18v-7\" class=\"motion grow delay1\" /><path d=\"M18 18v-5\" class=\"motion grow delay2\" />"
  },
  "plugin": {
    "name": "插件",
    "body": "<path d=\"M5 11v9a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3v-9h-6\" /><g class=\"motion plug\"><path d=\"M10 3v5 M16 3v5 M8 8h10v5a5 5 0 0 1-10 0z M13 18v4\" /></g>"
  }
};
