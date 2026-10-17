// Public distribution rules. Inventories record reviewed paths; these rules
// independently reject build output, local state and unsupported package files.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const rootFiles = new Set(['AGENTS.md', 'LICENSE', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'skills-lock.json', '.gitignore', '.gitleaks.toml', '.npmrc', '.gitattributes', '.claude-plugin/marketplace.json']);
const sourceRoots = new Set(['bin', 'src', 'test', 'scripts', 'config', 'commands', 'skills', 'schemas', 'examples', 'docs', 'plugins', 'specs', '.github']);
const packageFiles = new Set(['bin/foo', 'bin/foo.mjs', 'package.json', 'README.md', 'LICENSE', 'skills-lock.json', 'docs/CHANGELOG.md', 'docs/THIRD_PARTY_NOTICES.md', 'config/pricing.yaml', 'config/routing-policy.yaml']);
const unsafe = p => p.startsWith('/') || p.includes('\\') || p.split('/').some(s => s === '..' || s === '.' || s === '') || /(?:^|\/)(?:\.env(?:\..*)?|\.foo|node_modules)(?:\/|$)|\.(?:pem|key|p12|pfx)$/.test(p);

export function sourceFindings(files) {
  return files.flatMap(p => {
    if (unsafe(p)) return [`local or unsafe source path: ${p}`];
    if (p.endsWith('.map') || /^(?:dist|dist-public)\//.test(p) || /^(?:src|test)\/.*\.(?:js|d\.ts|mjs|cjs)$/.test(p)) return [`compiled output in source: ${p}`];
    if (!rootFiles.has(p) && (!p.includes('/') || !sourceRoots.has(p.split('/')[0]))) return [`unsupported public source path: ${p}`];
    return [];
  });
}

export function packageFindings(files, sources) {
  const reviewed = new Set(sources);
  return files.flatMap(p => {
    if (unsafe(p) || p.split('/').some(s => s.startsWith('.'))) return [`local or unsafe package path: ${p}`];
    if (p.startsWith('dist-public/src/') && /\.(?:js|d\.ts)$/.test(p)) {
      const source = p.replace(/^dist-public\//, '').replace(/\.(?:d\.ts|js)$/, '.ts');
      return reviewed.has(source) ? [] : [`compiled module has no reviewed source: ${p}`];
    }
    const content = /^(?:skills\/.*\.(?:md|yaml|json)|commands\/[^/]+\.md|schemas\/.*\.json)$/.test(p);
    return (packageFiles.has(p) || content) && reviewed.has(p) ? [] : [`unsupported or unreviewed package path: ${p}`];
  });
}

export function inventoryFindings(actual, reviewed) {
  const a = new Set(actual), r = new Set(reviewed);
  return [
    ...[...a].filter(p => !r.has(p)).sort().map(p => `unreviewed: ${p}`),
    ...[...r].filter(p => !a.has(p)).sort().map(p => `missing: ${p}`),
    ...(a.size !== actual.length || r.size !== reviewed.length ? ['duplicate inventory entries'] : []),
  ];
}

export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
}

export function packedFiles(root) {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 }));
  return packed[0].files.map(f => f.path).sort();
}

export function readInventory(root, name) {
  const file = path.join(root, 'config', name);
  if (!existsSync(file)) throw new Error(`Missing reviewed inventory config/${name}. Run npm run build:public, stage intended files, then node scripts/generate-public-manifests.mjs --write and review the diff.`);
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data.schema_version !== 1 || !Array.isArray(data.files) || data.files.some(p => typeof p !== 'string')) throw new Error(`Invalid inventory config/${name}`);
  return data.files;
}

export function requireClean(findings, label) {
  if (findings.length) throw new Error(`${label}:\n${findings.map(f => `  ${f}`).join('\n')}`);
}
