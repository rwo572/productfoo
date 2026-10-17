# Inactive-user re-engagement — shaping example

This is an illustrative Acme SaaS schema, partial application, and feature spec.
Use synthetic accounts only. No customer dataset or completed email campaign is
included. Historical statements about agent trials in the spec are context, not
reproducible benchmark evidence or a prediction of current model behavior.

Read [the spec](specs/reengagement-v0/spec.md), then [schema.sql](schema.sql).
The central question is whether a person who stopped logging in still receives
value through their team's API activity. The packet describes the intended
feature; the included application does not implement it.

## Setup and limits

Reading the example requires no installation. To explore it, copy it into a
disposable project and use a local database with synthetic records. Dependencies
are listed in `package.json`; there is no lockfile or supported turnkey setup.
Before executing the schema, create `teams` before `users`, which references it.
The server's `req.teamId` has no authentication middleware here, and no automated
test, inactivity calculation, draft/release workflow, or scheduled job is included.

`src/mailer.js` is a real Resend client stub, not a mock: with credentials it can
send externally. Replace it with a local recording fake before experimentation.
Do not supply a real API key, production database, or recipient address. A runnable
production implementation needs explicit recipient approval, authentication,
validation, and tests for the agreed requirements.
