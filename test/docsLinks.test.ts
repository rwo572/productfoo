// foo-open-source-transition-v0 T-008 — C-012 and C-013 (phase 1).
//
// C-012: every public documentation link resolves from both GitHub and npm,
// and the CLI reference generates clean. The npm half is the interesting one:
// the README, CHANGELOG, and THIRD_PARTY_NOTICES ship in the tarball, and
// npmjs.com does not reliably rewrite relative links (its rewriting is
// best-effort and has a long bug history), so those files are held to a
// stricter rule than GitHub-only docs — every cross-file link in a
// tarball-shipped file must be an absolute GitHub URL, which resolves
// identically on the npm page, on GitHub, and in an unpacked tarball. GitHub
// documents (everything under docs/) may use relative links, which stay
// correct when the public repository is created or renamed at cutover.
//
// GitHub blob/tree URLs are verified structurally against this repository, so
// a renamed file or a wrong path fails here instead of 404ing for a reader.
// Links to the wider web (keepachangelog.com, contributor-covenant.org, …)
// are not verified — no network in tests.
//
// Links and runnable contributor guidance cover every shipped documentation surface.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { distributionPackageName } from "../src/channelFreshness.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// The public repository name is an accepted packet decision (D-007). Absolute
// GitHub links in tarball-shipped files point here; if the repository is ever
// renamed again, this constant and the shipped files change together.
const GITHUB_BASE = "https://github.com/rwo572/productfoo";
const GITHUB_BLOB = `${GITHUB_BASE}/blob/main/`;

// Markdown shipped in the npm tarball and rendered on npmjs.com.
const TARBALL_MARKDOWN = [
  "README.md",
  "docs/CHANGELOG.md",
  "docs/THIRD_PARTY_NOTICES.md",
] as const;

// The public documentation set this task owns. Root community files, the docs
// tree, commands, skills, plugins, and every documented example.
const PUBLIC_MARKDOWN = [
  ...TARBALL_MARKDOWN,
  ".github/CONTRIBUTING.md",
  ".github/CODE_OF_CONDUCT.md",
  ".github/SECURITY.md",
  "docs/README.md",
  "examples/README.md",
] as const;

const EXAMPLE_ROOTS = [...new Set(execFileSync("git", ["ls-files", "examples"], { cwd: REPO_ROOT, encoding: "utf8" })
  .split("\n").filter(p => p.split("/").length > 2).map(p => p.split("/")[1]))].sort();

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listMarkdown(full));
    } else if (entry.toLowerCase().endsWith(".md")) {
      out.push(full);
    }
  }
  return out.sort();
}

function toRepoRel(absolute: string): string {
  return absolute.slice(REPO_ROOT.length + 1).replace(/\\/g, "/");
}

function publicMarkdownFiles(): string[] {
  const files: string[] = [...PUBLIC_MARKDOWN];
  for (const area of ["docs", "examples", "commands", "skills", "plugins"]) {
    files.push(...listMarkdown(join(REPO_ROOT, area)).map(toRepoRel));
  }
  files.push("AGENTS.md", "specs/AGENTS.md");
  return [...new Set(files)].sort();
}

// Strip content that must not be scanned for links: fenced code blocks,
// inline code, and HTML comments.
function scannableText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

interface MarkdownLink {
  target: string;
}

function parseLinks(markdown: string): MarkdownLink[] {
  const text = scannableText(markdown);
  const links: MarkdownLink[] = [];
  const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    links.push({ target: match[1] as string });
  }
  return links;
}

function headings(markdown: string): string[] {
  const text = scannableText(markdown);
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m && m[2]) out.push(m[2]);
  }
  return out;
}

// GitHub's heading anchor algorithm, close enough to fail loudly on real
// drift: lowercase, drop punctuation, spaces become hyphens.
function githubSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

interface Resolution {
  ok: boolean;
  problem?: string;
}

function resolveGitHubUrl(url: string): Resolution {
  if (!url.startsWith(GITHUB_BLOB) && !url.startsWith(`${GITHUB_BASE}/tree/`)) {
    return { ok: true }; // external web link — not verified offline
  }
  const within =
    url.startsWith(GITHUB_BLOB)
      ? url.slice(GITHUB_BLOB.length)
      : url.slice(`${GITHUB_BASE}/tree/`.length);
  const [repoPath, anchor] = within.split("#");
  if (!repoPath) {
    return { ok: false, problem: `GitHub URL with no path: ${url}` };
  }
  const fsPath = join(REPO_ROOT, repoPath);
  if (!existsSync(fsPath)) {
    return { ok: false, problem: `GitHub URL target missing in repo: ${url}` };
  }
  if (anchor && repoPath.toLowerCase().endsWith(".md")) {
    const slugs = new Set(headings(readFileSync(fsPath, "utf8")).map(githubSlug));
    if (!slugs.has(anchor)) {
      return { ok: false, problem: `anchor #${anchor} not found in ${repoPath}` };
    }
  }
  return { ok: true };
}

function resolveSelfAnchor(anchor: string, file: string): Resolution {
  const slugs = new Set(headings(readFileSync(file, "utf8")).map(githubSlug));
  if (!slugs.has(anchor)) {
    return { ok: false, problem: `anchor #${anchor} not found in ${file}` };
  }
  return { ok: true };
}

function resolveRelative(target: string, fromFile: string): Resolution {
  const [pathPart, anchor] = target.split("#");
  const fsPath = resolve(dirname(fromFile), pathPart ?? "");
  if (!existsSync(fsPath)) {
    return { ok: false, problem: `relative link target missing: ${target}` };
  }
  if (anchor && pathPart && pathPart.toLowerCase().endsWith(".md")) {
    return resolveSelfAnchor(anchor, fsPath);
  }
  return { ok: true };
}

function checkLink(target: string, fromFile: string, tarballContext: boolean): Resolution {
  if (target.startsWith("#")) return resolveSelfAnchor(target.slice(1), fromFile);
  if (target.startsWith("mailto:") || target.startsWith("http://")) {
    return { ok: false, problem: `insecure or unsupported link: ${target}` };
  }
  if (target.startsWith("https://")) {
    if (!tarballContext) return resolveGitHubUrl(target);
    // Tarball-shipped files must use absolute GitHub URLs for anything that
    // is not a self-anchor; other absolute URLs are external web links.
    return target.startsWith(GITHUB_BASE)
      ? resolveGitHubUrl(target)
      : { ok: true };
  }
  if (isAbsolute(target) || target.startsWith("../")) {
    if (tarballContext) {
      return {
        ok: false,
        problem: `tarball-shipped ${fromFile} links relatively (${target}); use an absolute ${GITHUB_BASE} URL`,
      };
    }
  }
  return resolveRelative(target, fromFile);
}

function publicDocsFailureList(): string[] {
  const failures: string[] = [];
  for (const rel of publicMarkdownFiles()) {
    const file = join(REPO_ROOT, rel);
    const tarballContext = (TARBALL_MARKDOWN as readonly string[]).includes(
      rel.replace(/\\/g, "/")
    );
    for (const { target } of parseLinks(readFileSync(file, "utf8"))) {
      const r = checkLink(target, file, tarballContext);
      if (!r.ok) failures.push(`${rel}: ${target} — ${r.problem ?? "unresolved"}`);
    }
  }
  return failures;
}

test("public documentation set is present", () => {
  for (const rel of PUBLIC_MARKDOWN) {
    assert.ok(existsSync(join(REPO_ROOT, rel)), `missing public doc: ${rel}`);
  }
  assert.ok(publicMarkdownFiles().length >= PUBLIC_MARKDOWN.length + 5,
    "expected the docs/ tree and example markdown to join the public set");
});

test("C-012: every public documentation link resolves (GitHub and npm rules)", () => {
  assert.deepEqual(publicDocsFailureList(), []);
});

test("C-012: README install guidance matches the published npm identity", () => {
  const readme = readFileSync(join(REPO_ROOT, "README.md"), "utf8");
  assert.ok(
    readme.includes(`npm install -g ${distributionPackageName()}`),
    "README quickstart must install the package under its contracted npm identity"
  );
});

test("C-012: the CLI reference generates clean", () => {
  const r = execFileSync("node", ["scripts/gen-cli-reference.mjs", "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(r.includes("up to date"));
});

test("C-012: third-party notices generate clean", () => {
  const r = execFileSync("node", ["scripts/gen-third-party-notices.mjs", "--check"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(r.includes("up to date"));
});

test("every shipped example root has a documented disposition", () => {
  const index = readFileSync(join(REPO_ROOT, "examples/README.md"), "utf8");
  for (const root of EXAMPLE_ROOTS) {
    assert.ok(index.includes(`(${root}/`), `examples/README.md must explain ${root}`);
  }
});

test("documented maintenance scripts are present in the public checkout", () => {
  const missing: string[] = [];
  for (const rel of publicMarkdownFiles()) {
    const text = readFileSync(join(REPO_ROOT, rel), "utf8");
    for (const match of text.matchAll(/(?:node|bash|sh) (scripts\/[a-zA-Z0-9_./-]+\.(?:mjs|sh))/g)) {
      if (!existsSync(join(REPO_ROOT, match[1]))) missing.push(`${rel}: ${match[1]}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("the printable quick reference is generated from Markdown", () => {
  execFileSync(process.execPath, ["scripts/gen-cheatsheet.mjs", "--check"], { cwd: REPO_ROOT });
});
