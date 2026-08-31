import assert from "node:assert/strict";
import { mergeWebQueuedInput } from "./index.js";

assert.equal(mergeWebQueuedInput(undefined, "first"), "first");
assert.equal(mergeWebQueuedInput("first", "second"), "first\nsecond");
assert.equal(mergeWebQueuedInput("first\n", "  second  "), "first\nsecond");

console.log("web queue smoke ok");
