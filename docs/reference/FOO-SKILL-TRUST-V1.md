# productfoo Skill Trust V1

## Bundled skills

The installed package carries its canonical skills and a build-time tree anchor.
The resolver verifies the complete bundled tree before returning instruction
bytes. The installed package root supplies these skills; an arbitrary caller
repository cannot shadow them. Skill integrity does not prove the instructions
are safe or that a model will follow them.

There is no hosted skill-delivery service or productfoo account login in the
public CLI. Old service tokens and endpoint settings cannot activate remote
skill retrieval. Direct provider credentials, such as Firecrawl API access,
are separate from skill trust.

If bundled files are missing or changed, reinstall the reviewed package. Do not
approve an unexplained modification just to make a check pass. Contributors
who deliberately edit canonical skills must regenerate their tree anchor and
rebuild; see [verification](../contributing/verification.md).

## Local development source

An arbitrary caller repository never supplies canonical productfoo skills. Development dogfooding requires an external, closed trust record that binds:

- the real productfoo source root;
- a deterministic SHA-256 over every file and link in every canonical skill directory;
- a canonical issue and expiry time.

The record must be a regular file outside the productfoo checkout and must not be group- or world-writable. The verifier snapshots the complete tree and retains the requested file's owned bytes from that same pass, so it does not validate one object and later read another. Symlinked instruction files are never returned.

Review the exact checkout before approving it. The first command is read-only:
it prints the real package root, complete skill-tree SHA-256, proposed expiry,
and external record path. Approval must repeat that exact digest; productfoo
re-snapshots the complete tree before atomically writing a mode-`0600` record.

```text
foo skill trust
foo skill trust --approve <reviewed-sha256> --days 30
```

The default record lives at
`~/.foo/trust/development-skill-source.json`. `--out` may select another
external regular file, and `--dev-trust-record` selects it for one inspection:

```text
foo skill foo-roast --dev-trust-record /absolute/external/development-skill-source.json
```

Any root change, skill-tree byte change, expiry, unknown field, symlinked record, unsafe permission, or repo-contained record returns the typed skill-delivery quarantine state.

## Shared trust primitives

The [signed-envelope primitive](TRUST-ENVELOPE-V1.md) remains available for the
product's signed artifacts and verification contracts. It is not an active
remote skill service or a way to bypass the bundled or development-source
checks described here.
