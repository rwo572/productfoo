# Library exports

Consumers import productfoo through the export map in `package.json`, never
through deep `dist/src/...` paths. The map is the
supported surface: a subpath it does not list is refused by Node
(`ERR_PACKAGE_PATH_NOT_EXPORTED`) and by TypeScript, so internal rearrangement
cannot break a consumer's build silently.

## The map

| Specifier | What a consumer gets |
| --- | --- |
| `.` (package root) | The curated library surface: the CLI bootstrap (`main`, `MainDeps`) and the Bug Capsule report API (`runReportCommand`, capture, review, local deletion). |
| `./cli` | The public CLI entrypoint module (`dist-public/src/cli.js` in the published package). |
| `./package.json` | The package manifest. |

Everything else is refused. There is deliberately no wildcard subpath: deep
imports into internal source modules are unsupported. The installed-package
smoke checks that the package root loads through this map.

The map points at `dist-public/`, the public build the published package ships
(`package.json` `files`). The contributor build uses `dist/`.
`scripts/smoke-public-package.mjs` (part of `npm run verify:public`) installs the
real tarball into a throwaway prefix and proves it starts, imports by name through
this map, and updates as an npm install.

## Package identity

Install the CLI with `npm install -g productfoo`, or add the library to your
project with `npm install productfoo`. Both use the release tagged `latest` on
npm. The terminal command is `foo`; library imports use `productfoo` or one of
the subpaths above.

## Types

The build emits declarations (`tsc` with `declaration`), and every supported
subpath maps its `types` condition first, so a strict TypeScript consumer with
`moduleResolution: "nodenext"` type-checks against exactly what Node resolves
at runtime.

## Growing the surface

Adding a subpath is a reviewed change to the dependency contract, not a
convenience: productfoo has no dependency on private service modules,
and each supported export widens what the public package promises to keep
stable. A new subpath must keep the package independent of private services.
Run `npm run verify:public` to check the packaged artifact and its supported
entrypoints.

## Local bug reporting

Bug and error reporting is fully local: capture, privacy scrubbing, storage,
review (`foo report show`), and deletion touch only this machine. Stored alpha
tokens, `FOO_SKILL_TOKEN`, and `FOO_SKILL_SERVER` cannot enable sending. The
end-of-run notice announces the local report and never asks to send it.

`runReportCommand` supports `add`, `show`, and `delete`. The removed `send`
command returns `E_REPORT_SEND_REMOVED` without a network request, prompt, or
change to the report. Report dependencies no longer accept transport, fetch,
or transport timeout hooks. The environment argument remains accepted for
compatibility and does not configure report delivery.

Pending reports require review and exact payload approval before deletion.
Older accepted archives remain readable with `show` and deletable locally with
exact payload approval. Their receipt is historical metadata; deleting the local
archive neither requests nor claims deletion at its historical destination.
Local cleanup markers distinguish local deletion from historical server-confirmed
records, so interrupted cleanup can be retried safely.

The exported `askToSendReports` name remains for library compatibility. It now
only announces the current invocation's saved local report once, in every mode;
it never prompts for sending or invokes an injected legacy transport.
