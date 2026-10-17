# Changelog

This changelog covers the public productfoo distribution. Pre-public development
records are not part of the public release history.

## 1.0.1 — October 17, 2026

Patch release from the fresh public repository. Includes updated README setup
guidance and section order, plus current installation documentation. CLI commands,
library exports, bundled skills, packet formats, and runtime requirements are
unchanged from 1.0.0.

## 1.0.0 — October 17, 2026

The initial release candidate includes the local CLI, bundled product-management
skills, spec workflows, research and discovery helpers, validation, reconciliation,
and scanning tools under Apache-2.0. The terminal command is `foo`.

The experimental sales-development subsystem (`foo sdr`) and its PostgreSQL
dependency were removed before release. Core spec, research, discovery, skill,
and reporting workflows need no database server.

The local workflows require no productfoo account or hosted service. Optional
model and connector workflows may use external services and incur charges.

productfoo is a personal open-source project with best-effort maintenance and
support. Agent behavior depends on the selected model, runtime, and permissions;
checks cannot guarantee correctness or safety. Read
[project status and responsible use](https://github.com/rwo572/productfoo#project-status-and-responsible-use)
before getting started.

Each published release is verified against its exact source and package bytes.
