import { mkdirSync, copyFileSync } from "node:fs";

mkdirSync("dist/model", { recursive: true });
copyFileSync("src/model/model-metadata.json", "dist/model/model-metadata.json");
