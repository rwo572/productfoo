# Outside-in audit template

Experimental renderer and historical writing playbook for an audit based on
public sources. No completed customer audit, private research, or outreach list
is included. The playbook's dated editorial choices are examples, not current
product policy or authorization to send messages.

Read [SCHEMA.md](SCHEMA.md) for the input contract and [PLAYBOOK.md](PLAYBOOK.md)
for the writing process. From the repository root, render reviewed JSON:

```sh
node examples/outside-in-audit/render.mjs /path/to/synthetic-audit.json > /tmp/audit-preview.html
```

Use synthetic content first and inspect the HTML locally. The `read` field
accepts trusted HTML; do not put untrusted source HTML in it. There is no source
retrieval, factual verification, hosting, or email delivery in this renderer.
Research must use the supported research workflow, and any external publication
or contact needs its own approval. Current sources must be checked before reusing
historical market claims or provider instructions.
