#!/usr/bin/env node
/**
 * build-swarm-skills.mjs — render the 25 `spec-swarm-<persona>` skills from one
 * canonical template plus per-persona data blocks.
 *
 * Source of truth:
 *   skills/spec-swarm/template/SKILL.template.md      shared 9-section skeleton
 *   skills/spec-swarm/template/personas/<persona>.md  differentiated content only
 *
 * Output (the flat-skill contract — paths and frontmatter names never change):
 *   skills/spec-swarm-<persona>/SKILL.md
 *
 * A generated SKILL.md must never be hand-edited; the shared skeleton can only
 * be improved once, here, instead of 25 times. `--verify` proves the committed
 * files still match what the template + data render to (a CI drift check).
 *
 * Usage:
 *   node scripts/build-swarm-skills.mjs            # (re)render all persona SKILL.md files
 *   node scripts/build-swarm-skills.mjs --verify   # fail if any generated file drifted
 *   node scripts/build-swarm-skills.mjs --list     # print persona -> path table, write nothing
 *
 * Template placeholder syntax:
 *   {{field}}                 inline substitution
 *   {{#if field}} / {{/if}}   marker lines (removed); block kept iff field is non-empty
 */

import { mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SKILLS_ROOT = join(ROOT, 'skills');
const TEMPLATE_DIR = join(SKILLS_ROOT, 'spec-swarm', 'template');
const TEMPLATE_PATH = join(TEMPLATE_DIR, 'SKILL.template.md');
const PERSONAS_DIR = join(TEMPLATE_DIR, 'personas');
// Inline the canonical voice so each generated persona remains self-contained.
const FOO_VOICE = readFileSync(join(SKILLS_ROOT, 'product-copywriting', 'references', 'foo-voice.md'), 'utf8').trim();

// Defaults applied when a persona data block omits the field.
const DEFAULTS = {
  usage_artifacts: 'spec, PRD-like spec, or `interview-me` swarm packet',
  lens: 'this lens',
  intro: '',        // verbatim intro override (only when the structured intro fields don't fit)
  intro_pov: '',    // "an accessibility and inclusion" -> "Sharpen the spec from {intro_pov} point of view..."
  intro_flavor: '', // optional " — the ... archetype" clause after "point of view"
  intro_decision: '', // "... and resolve the {intro_decision} decision before moving on."
  intro_extra: '',  // optional extra sentences appended to the intro (leading space included)
};

const args = process.argv.slice(2);
const has = (f) => args.includes(f);

// --- persona data ------------------------------------------------------------

// Parse a persona data block: YAML frontmatter + `## `-delimited markdown sections.
function loadPersona(file) {
  const raw = readFileSync(join(PERSONAS_DIR, file), 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${file}: missing YAML frontmatter`);
  const fields = YAML.parse(m[1]);
  const body = raw.slice(m[0].length);
  const sections = {};
  let cur = null;
  for (const line of body.split('\n')) {
    const h = line.match(/^## (.+)$/);
    if (h) { cur = h[1]; sections[cur] = []; continue; }
    if (cur) sections[cur].push(line);
  }
  for (const k of Object.keys(sections)) {
    sections[k] = sections[k].join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  }
  const pick = (name) => sections[name] ?? '';
  const data = {
    ...DEFAULTS,
    ...fields,
    intro: pick('Intro'),
    focus: pick('Focus'),
    borrow: pick('Borrow From Existing Skills'),
    grounding: pick('Grounding'),
    question_bank: pick('Question Bank'),
    question_selection: pick('Question Selection'),
    error_handling: pick('Error Handling'),
  };
  data.question_bank_clause = data.question_bank ? ', drawn from the Question Bank' : '';

  // Contract checks: swarm skills must keep the persona signal and the rich
  // personas' Grounding + Question Bank pairing intact.
  const required = ['name', 'title', 'description_pov', 'description_wants', 'question', 'spec_impact', 'sources', 'guardrails', 'focus', 'question_selection', 'error_handling'];
  for (const k of required) {
    if (!data[k]) throw new Error(`${file}: missing required field/section "${k}"`);
  }
  if (data.intro && data.intro_pov) {
    throw new Error(`${file}: use either a verbatim Intro section or the structured intro_* fields, not both`);
  }
  if (!data.intro && !(data.intro_pov && data.intro_decision)) {
    throw new Error(`${file}: needs an Intro section or intro_pov + intro_decision fields`);
  }
  if (!!data.grounding !== !!data.question_bank) {
    throw new Error(`${file}: Grounding and Question Bank must be present together`);
  }
  if (!data.grounding && !data.borrow) {
    throw new Error(`${file}: needs either Borrow From Existing Skills or Grounding + Question Bank`);
  }
  if (data.name !== `spec-swarm-${file.replace(/\.md$/, '')}`) {
    throw new Error(`${file}: frontmatter name "${data.name}" does not match file name`);
  }
  return data;
}

function loadPersonas() {
  return readdirSync(PERSONAS_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map(loadPersona);
}

// --- rendering ---------------------------------------------------------------

function render(template, persona) {
  // Persona data cannot override the shared human-output rules.
  const data = { ...persona, foo_voice: FOO_VOICE };
  // Strip the leading self-documentation comment; generated files start at `---`.
  let out = template.replace(/^<!--[\s\S]*?-->\n/, '');
  // {{#if field}} ... {{/if}} blocks: marker lines removed; block kept iff truthy.
  out = out.replace(/\{\{#if ([a-z_]+)\}\}\n([\s\S]*?)\{\{\/if\}\}\n/g, (_, field, block) =>
    data[field] ? block : '');
  // Inline {{field}} substitution.
  out = out.replace(/\{\{([a-z_]+)\}\}/g, (_, field) => {
    if (data[field] === undefined) throw new Error(`${data.name}: template references unknown field "${field}"`);
    return data[field];
  });
  return out;
}

// --- commands ------------------------------------------------------------------

const template = readFileSync(TEMPLATE_PATH, 'utf8');
const personas = loadPersonas();

if (has('--list')) {
  for (const p of personas) {
    const kind = p.grounding ? 'rich (grounding + question bank)' : 'plain';
    console.log(`${p.name.padEnd(40)} skills/${p.name}/SKILL.md  ${kind}`);
  }
  console.log(`\n${personas.length} personas rendered from ${TEMPLATE_PATH.replace(ROOT + '/', '')}`);
} else if (has('--verify')) {
  const problems = [];
  const expected = new Set(personas.map((p) => p.name));
  for (const p of personas) {
    const path = join(SKILLS_ROOT, p.name, 'SKILL.md');
    if (!existsSync(path)) { problems.push(`missing generated skill: ${p.name}`); continue; }
    const rendered = render(template, p);
    const committed = readFileSync(path, 'utf8');
    if (rendered !== committed) problems.push(`content drift (hand-edit?): skills/${p.name}/SKILL.md`);
  }
  // A persona skill dir with no data block is drift too (a hand-added 26th file).
  for (const d of readdirSync(SKILLS_ROOT)) {
    if (d.startsWith('spec-swarm-') && !expected.has(d) && existsSync(join(SKILLS_ROOT, d, 'SKILL.md'))) {
      problems.push(`persona skill without a data block: skills/${d}`);
    }
  }
  if (problems.length) {
    console.error('DRIFT — spec-swarm persona skills are out of sync with the canonical template:');
    for (const p of problems) console.error('  - ' + p);
    console.error('\nEdit skills/spec-swarm/template/ (never the generated SKILL.md) and regenerate with:');
    console.error('  node scripts/build-swarm-skills.mjs');
    process.exit(1);
  }
  console.log(`OK — ${personas.length} spec-swarm persona skills match the canonical template + data.`);
} else {
  for (const p of personas) {
    mkdirSync(join(SKILLS_ROOT, p.name), { recursive: true });
    writeFileSync(join(SKILLS_ROOT, p.name, 'SKILL.md'), render(template, p));
  }
  console.log(`Rendered ${personas.length} spec-swarm persona skills from the canonical template.`);
}
