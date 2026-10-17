# CLI reference

This is the complete command surface of the `foo` CLI, captured from
`foo help --all`. The file is generated — do not edit it by hand. To
regenerate it after changing help text, run:

```bash
node scripts/gen-cli-reference.mjs
```

Every command also reports its own usage when run without required arguments.
If this reference and the CLI ever disagree, the CLI is the source of truth:
[file an issue](https://github.com/rwo572/productfoo/issues).

<!-- The listing below is generated; edit the CLI's help text instead. -->

```text
Usage:
  foo --version
  foo self which   (show the current build)
  foo init [--json] [--pick <n>] [--intent <text>] [--pm] [--attach-proof <text>]
  foo profile [redo]   (what productfoo knows about how you work — local; redo re-asks the first-run questions)
  foo profile set [--role <r>]… [--harness <a>[,<a>…]] [--team <t>] [--building <text>] [--json]   (record answers gathered in chat)
  foo doctor [--json]
  foo roast <artifact> [--mode auto|panel|single]
  foo preview <packet-dir>
  foo research <topic> [--depth fast|standard|deep] [--days 30] [--end-date YYYY-MM-DD] [--out <path>] [--json]   (plan an untrusted research run; exact-byte validation is available and promotion remains human-approved)
  foo research gather <topic> [--days 30] [--end-date YYYY-MM-DD] [--sources ...] [--limit N] [--json]   (reads public recent-signal endpoints; read-only)
  foo research validate <paper.md> [--format] [--strict] [--json]   (refuses any paper without a genuine completion receipt)
  foo research view <paper.md> [--out <path>] [--stdout]   (render a report to a self-contained HTML page)
  foo research <topic> [--firecrawl plugin|api] --public-query <public terms>   (plugin handoff or direct API search)
  foo research firecrawl plugin-prepare --run <id> --request-stdin   (prepare host tool call)
  foo research firecrawl plugin-record --run <id> --result-stdin   (record host-reported response)
  foo research firecrawl search --run <id> --request-stdin   (resume required public retrieval)
  foo research seal <paper.md>   (mint/seal the completion receipt that makes a paper citable)
  foo discovery plan [--study <id>|--inbox] [--json]
  foo discovery match <study-id> --sessions-stdin [--json]
  foo discovery apply <study-id> --evidence-stdin [--json]
  foo discovery validate [<discovery-path>] [--json]
  foo discovery tie --auto [--within inbox] [--json]   (auto-tie genuine matches; weak, catch-all, and no-home records stay untied)
  foo discovery contact <scope-id> [--name <text>] [--linkedin <url>] [--company <text>] [--title <text>] --by <person> | --infer [--json]
  foo discovery contact --sweep [--json]   (backfill inferred contact candidates for every scope from data already on disk)
  foo discovery review <target> <complete|tie|untie|attach|detach|restore|promote|dismiss|select-source> --by <person> [options]
  foo discovery revoke <study-or-source> --by <person> [--json]
  foo discovery sync [--json]
  foo discovery gong ready [--json]   (company Gong connection through Nango: readiness, observed capabilities, policy ceilings)
  foo discovery gong list <study-id|inbox:scope-id> [--json]   (bounded call metadata + strict match; opens no transcript)
  foo discovery gong process <study-id|inbox:scope-id> [--json]   (exactly one proof-authorized transcript → sanitized envelope → local apply)
  foo discovery gong sync [--json]   (metadata + match for every approved Gong lane; never opens a transcript)
  foo discovery zoom ready [--json]   (company Zoom connection through Nango: readiness, observed capabilities, policy ceilings)
  foo discovery zoom list <study-id|inbox:scope-id> [--json]   (bounded recording metadata + strict match; opens no transcript)
  foo discovery zoom process <study-id|inbox:scope-id> [--json]   (exactly one proof-authorized transcript → sanitized envelope → local apply)
  foo discovery zoom sync [--json]   (metadata + match for every approved Zoom lane; never opens a transcript)
  foo discovery slack ready [--json]   (company Slack connection through Nango: readiness, observed capabilities, policy ceilings)
  foo discovery slack list <inbox:scope-id> [--json]   (content-free transcription of the scope's explicit thread selection; opens no thread)
  foo discovery slack process <inbox:scope-id> [--thread <channel-id>/<ts>] [--json]   (exactly one proof-authorized thread read → summary-only decision_context envelope → local apply)
  foo discovery fireflies ready [--json]   (your own Fireflies key: readiness, observed capabilities, policy ceilings; the connection sees only your meetings)
  foo discovery fireflies list <study-id|inbox:scope-id> [--json]   (bounded transcript metadata + strict match; opens no transcript)
  foo discovery fireflies process <study-id|inbox:scope-id> [--json]   (exactly one proof-authorized transcript → sanitized envelope → local apply)
  foo discovery fireflies sync [--json]   (metadata + match for every approved Fireflies lane; never opens a transcript)
  foo discovery teams ready|sync [--json]   (tenant Microsoft Teams connection through Nango: readiness, or metadata + match for every approved lane)
  foo discovery teams list|process <study-id|inbox:scope-id> [--json]   (bounded metadata + strict match; process opens exactly one proof-authorized transcript)
  foo discovery zendesk ready|sync [--json]   (company Zendesk connection through Nango: readiness, or metadata + match for every approved lane)
  foo discovery zendesk list|process <study-id|inbox:scope-id> [--json]   (bounded ticket metadata + strict match; process opens exactly one proof-authorized ticket)
  foo discovery gmail ready|sync [--json]   (Gmail through Nango, explicit labels and time window: readiness, or metadata + match for every approved lane)
  foo discovery gmail list|process <inbox:scope-id> [--json]   (bounded message metadata + strict match; process opens exactly one proof-authorized thread)
  foo discovery outlook ready|sync [--json]   (Outlook through Nango, explicit folders and time window: readiness, or metadata + match for every approved lane)
  foo discovery outlook list|process <inbox:scope-id> [--json]   (bounded message metadata + strict match; process opens exactly one proof-authorized thread)
  foo discovery notion ready [--json]   (company Notion connection through Nango: readiness and policy ceilings)
  foo discovery notion list <packet-name-or-path> [--json]   (pages in the packet's approved Notion scope; opens no page)
  foo discovery notion process <packet-name-or-path> --page <page-id> [--json]   (exactly one proof-authorized page → sanitized envelope → local apply)
  foo reconcile --source github:<pr-url> [--source-fixture <file.json>] [--json] [--adopt --packet <name> [--by <who>]]   (packet-free: recover a PR's intent, diff the change against it, report drift + unproven claims)
  foo detect <packet-dir|file|dir> [--json] [--exit-code] [--strict]
  foo spec start <work-item> [--request <text>] [--packet <name>] [--skill <required-skill>...] [--companion ponytail|--ponytail]
  foo spec from <what-you-built> [--out <path>] [--json]
  foo spec nudge   (advisory post-commit: flags product code shipped with no spec link)
  foo spec patch <packet-dir> --correction <text> [--json]   (inspectable proposal; never writes)
  foo decision add <packet-dir> --summary <correction> [--by <who>] [--json]
  foo spec panel <what-you-built> [--json]   (review-only)
  foo spec canonize <what-you-built> --packet <name> --confirm-batch --by <who> [--json]
  foo spec accept <packet-dir> --finding <F-xxx> --lens <lens> --label <text> --by <who> --reason <why>
  foo agent status [--json|--markdown] [--agent <agent>|all]
  foo agent doctor
  foo agent setup [--agent <agent>|all] [--scope project|global] [--dry-run] [--json] [--yes]
  foo agent log --kind failure|poor_experience|good_experience --summary <text> [--prompt-summary <text>] [--prompt <text>] [--prompt-mode metadata|summary|raw] [--json]
  foo agent rate --checkpoint <name> --rating <field>=<1-7> [--rating ...] [--note <k>=<v>] [--reroute spec|review|artifact|none] [--baseline-mode <m>] [--packet <p>] [--commit <c>] [--artifact <a>] [--json]
  foo agent logs [--usage] [--ratings] [--json]
  foo agent telemetry status|enable|disable|set-id <id>|reset-id [--json]
  foo spec <work> [--request <text>] [--companion ponytail|--ponytail] [--source linear:<issue-or-project-url> --source-fixture <file.json>]   (spec-first reflex; `foo spec start` is the full loop)
  foo pitch <opportunity> [--json]   (GO / NOT-NOW / NO-GO plan; web inputs remain untrusted and unproven)
  foo ideate "<raw idea>" [--depth fast|standard|deep] [--json]   (pre-spec ideation: independent pools -> stress -> shortlist)
  foo ideate check <record.md> [--before-build-on] [--json]
  foo ideate result <record.md> [--json]
  foo ideate context "<idea>" [--json]
  foo feedback "<what you think>"   (record feedback locally — nothing is sent; redacted before store, honors telemetry opt-out)
  foo report add|show|delete   (local reports; review before exact deletion approval)
  foo bug log --expected <text> --actual <text> [--reproduction <text>] [--suggest <text>] [--refs "#528,#529"] [--json]   (optional GitHub filing to your own private tracker; requires gh and FOO_BUG_OWNER_REPO)
  foo swarm <spec-path-or-summary> [--depth fast|standard|deep] [--json]   (prepare an expert review + durable record)
  foo swarm check <record.md> [--json]
  foo login --firecrawl <key>   (save your own Firecrawl API key)
  foo logout --firecrawl       (forget the saved Firecrawl key)
  foo update [--check] [--json]   (install the newest published build — foo tells you when there is one)
  foo skill <name> [--dev-trust-record <external-record.json>]   (verified bundled skills or an explicitly approved development tree; caller-repository shadowing is refused)
  foo skill trust [--json] [--approve <sha256>] [--days 1..365] [--out <external-file>]   (review, then approve one exact development skill tree)
  foo evidence sweep <governing-packet> --fixture <sources.json> [--out <name>] [--json]
  foo evidence disposition <pending-packet> <E-xxx> --action accept|override|reject [--route r] --by <who>
  foo commands list [--json]   (canonical command contract for adapters)
  foo commands validate [--json]   (surface docs-vs-contract drift)
  foo command show <name> [--json]
  foo classify <work> [--override <reason>] [--json]
  foo elicitation surface [--json]
  foo elicitation render
  foo runtime [--json]   (active harness + resolved model; flags GLM-behind-Claude, e.g. z.ai/Fireworks)
  foo commit-trailer <packet>
  foo self check [--json]
  foo self gate [--reason <text>]   (pre-commit: block staged high-confidence secrets)
  foo scan <file|dir|-> [--json] [--exit-code] [--allow <file>] [--profile <names>] [--min-entropy-len <n>]
  foo redact <file|-> [--dry-run] [--write] [--json] [--high-only] [--include-low] [--allow <file>] [--profile <names>]
  foo loop design <packet-dir>
  foo loop check <packet-dir> [--strict-budget]
  foo loop status <packet-dir>
  foo loop estimate <packet-dir> [--loop <id>] [--unit usd|tokens] [--agree] [--count-tokens] [--structural] [--json]
  foo loop routine <packet-dir> [--emit <runtime>] [--routine <id>] [--json] [--strict]
  foo estimate <packet-dir> [--tier core|next|deferred|all] [--unit usd|tokens] [--passes <n>] [--count-tokens] [--structural] [--json]
  foo asp validate <packet-dir> [--strict] [--json] [--fix]
  foo asp migrate <packet-dir> [--dry-run] [--json]   (mint missing anchor IDs in place; never rewrites existing text)
  foo asp reconcile <packet-dir> [args...]
  foo asp reconcile <packet-dir> --source github:<pr-or-repo-url> [--source-fixture <file.json>] [--json]
  foo asp verify <packet-dir> [--json] [--strict] [--record]
  foo asp status <packet-dir> [--json] [--deep] [--rich|--plain] [--html [path]]
  foo asp index [--json] [--html [path]] [--serve [--port <n>]]
  foo asp init <name|path>
  foo asp event <packet-dir> <type> [--subject <s>] [--data <json>] [--summary <text>]
  foo asp task <packet-dir> <task-id> --status <todo|doing|blocked|done|dropped> [--proof <p>] [--summary <text>] [--reason <text>] [--needs <a,b>]
  foo asp verdict <packet-dir> <parked|killed|active|done> --reason <text>
  foo eval validate <packet-dir> [--json]   (records lint: identity, approval, no runner vocabulary)
  foo eval compile <packet-dir> --roast <run.json> [--json]   (roast candidates -> unapproved eval records)
  foo eval approve <packet-dir> --check <E-xxx> --by <who>
  foo eval reject <packet-dir> --check <E-xxx> --by <who> --reason <why>
  foo eval run <packet-dir> --target <file> [--strict] [--json]   (deterministic now; judges need a transport)
  foo eval label <packet-dir> [--count=10] [--suite <name>] [--judge <E-xxx>] [--dispute <hash-prefix>]   (blind owner labels -> private corpus)
  foo source discover <packet-dir> --surface <file.json> [--json]
  foo source classify <provider> [--json]
  foo source approve <packet-dir> --provider <p> --connection <id> [--external-id <id>] [--ingress mcp|nango|custom] --scope <s> --by <who> [--json]
  foo source claim <packet-dir> --provider <p> --connection <id> --selection <schema.table> --claim <text> --task <task-id> --direction supports|contradicts [--json]
  foo source revoke <packet-dir> --provider <p> --connection <id> [--external-id <id>] [--ingress mcp|nango|custom] --by <who> [--json]
      (also fans out a privilege-reducing discovery_suspend_target to every registered hosted discovery target; reports revocation_pending when the service cannot acknowledge)
  foo source receipt <packet-dir> [--surface <file.json>] [--json]
```
