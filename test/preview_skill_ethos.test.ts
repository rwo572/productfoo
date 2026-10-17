import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("preview skills frame Build Previews as fast control surfaces", () => {
  const buildPreviewSpec = readFileSync("skills/build-preview-spec/SKILL.md", "utf8");
  const previewSwarm = readFileSync("skills/preview-swarm/SKILL.md", "utf8");

  assert.match(buildPreviewSpec, /control preview/i);
  assert.match(buildPreviewSpec, /not a design handoff/i);
  assert.match(buildPreviewSpec, /direct-to-app/i);
  assert.match(buildPreviewSpec, /60 seconds/i);
  assert.match(buildPreviewSpec, /Build this/);
  assert.match(buildPreviewSpec, /Skip preview next time/);

  assert.match(previewSwarm, /name: preview-swarm/);
  assert.match(previewSwarm, /# Preview Swarm/);
  assert.match(previewSwarm, /Build Preview/);
  assert.match(previewSwarm, /Default to one strong Build Preview/i);
  assert.match(previewSwarm, /Divergent variants are only/i);
  assert.match(previewSwarm, /Build this/);
  assert.match(previewSwarm, /Skip preview next time/);
});

test("preview swarm uses Impeccable as its design review companion", () => {
  const previewSwarm = readFileSync("skills/preview-swarm/SKILL.md", "utf8");
  const agentPrompt = readFileSync("skills/preview-swarm/agents/openai.yaml", "utf8");

  assert.match(previewSwarm, /## Impeccable Collaboration Contract/);
  assert.match(previewSwarm, /node \.agents\/skills\/impeccable\/scripts\/context\.mjs --target <artifact-or-source>/);
  assert.match(previewSwarm, /\$impeccable shape <source-or-shape-brief>/);
  assert.match(previewSwarm, /\$impeccable critique <artifact>/);
  assert.match(previewSwarm, /\$impeccable audit <artifact>/);
  assert.match(previewSwarm, /\$impeccable polish <artifact>/);
  assert.match(previewSwarm, /Do not mark the preview-swarm output complete/i);
  assert.match(previewSwarm, /P0\/P1/);
  assert.match(agentPrompt, /then run the Impeccable collaboration contract/);
});


test("preview comments have one chat handoff path", () => {
  const previewSwarm = readFileSync("skills/preview-swarm/SKILL.md", "utf8");
  const htmlPatterns = readFileSync("skills/preview-swarm/references/html-effectiveness-build-previews.md", "utf8");

  assert.match(previewSwarm, /Send to agent chat/);
  assert.match(previewSwarm, /foo\.preview\.feedback/);
  assert.match(previewSwarm, /Copied for chat|Sent to agent chat/);
  assert.match(previewSwarm, /floating composer/i);
  assert.match(previewSwarm, /JSON is available only inside `Show details`/);
  assert.match(htmlPatterns, /one obvious path back to the agent chat/i);
  assert.match(htmlPatterns, /floating popover/i);
  assert.match(htmlPatterns, /secondary JSON details only inside a disclosure/i);
});

test("preview option controls distinguish recommended from selected", () => {
  const previewSwarm = readFileSync("skills/preview-swarm/SKILL.md", "utf8");
  const htmlPatterns = readFileSync("skills/preview-swarm/references/html-effectiveness-build-previews.md", "utf8");

  assert.match(previewSwarm, /selected option owns the filled highlight/i);
  assert.match(previewSwarm, /recommended-but-not-selected/i);
  assert.match(previewSwarm, /aria-pressed/);
  assert.match(htmlPatterns, /selected direction owns the filled highlight/i);
});

test("preview context does not bury the workbench", () => {
  const previewSwarm = readFileSync("skills/preview-swarm/SKILL.md", "utf8");
  const htmlPatterns = readFileSync("skills/preview-swarm/references/html-effectiveness-build-previews.md", "utf8");

  assert.match(previewSwarm, /Do not render decision context as a permanent full-width card strip/i);
  assert.match(previewSwarm, /closed `details` disclosure/i);
  assert.match(htmlPatterns, /Decision context is on-demand/i);
  assert.match(htmlPatterns, /not a row of always-visible cards/i);
});

test("preview option switching stays visually secondary", () => {
  const previewSwarm = readFileSync("skills/preview-swarm/SKILL.md", "utf8");
  const htmlPatterns = readFileSync("skills/preview-swarm/references/html-effectiveness-build-previews.md", "utf8");

  assert.match(previewSwarm, /Do not render a separate storyboard/i);
  assert.match(previewSwarm, /option switching must stay visually secondary/i);
  assert.match(htmlPatterns, /Do not duplicate page controls with a storyboard/i);
  assert.match(htmlPatterns, /preview canvas should get the width/i);
});
