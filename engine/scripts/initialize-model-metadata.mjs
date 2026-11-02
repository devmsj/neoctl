import { existsSync } from "node:fs";
const moduleUrl = new URL("../dist/model/context-window.js", import.meta.url);
if (existsSync(moduleUrl)) {
  const { loadModelCatalog } = await import(moduleUrl.href);
  loadModelCatalog();
}
