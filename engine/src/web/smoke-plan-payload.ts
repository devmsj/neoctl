import assert from "node:assert/strict";
import { isWebPlanPayload, serializeWebPlanPayload } from "./plan-payload.js";

const plan = {
  title: "Nested plan",
  summary: "2/6 completed",
  total: 6,
  completed: 2,
  items: [
    { description: "Top-level complete", status: "completed" },
    {
      description: "Generate images",
      status: "in_progress",
      subitems: [
        { description: "Image one", status: "completed" },
        { description: "Image two", status: "in_progress" },
        { description: "Image three", status: "pending" },
      ],
    },
    { description: "Publish", status: "pending" },
  ],
};

assert.equal(isWebPlanPayload(plan), true);
if (!isWebPlanPayload(plan)) throw new Error("nested plan payload was rejected");
const restored = JSON.parse(serializeWebPlanPayload(plan));
assert.equal(restored.items.length, 3);
assert.equal(restored.items[1].subitems.length, 3);
assert.equal(restored.items[1].subitems[1].description, "Image two");

console.log("web plan payload smoke ok");
