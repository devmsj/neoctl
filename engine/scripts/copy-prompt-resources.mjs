import { copyFile, mkdir } from "node:fs/promises";

const destination = new URL("../dist/context/", import.meta.url);
await mkdir(destination, { recursive: true });
await copyFile(new URL("../src/context/system.md", import.meta.url), new URL("system.md", destination));
