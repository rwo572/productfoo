# Public alpha cleanup implementation plan

Goal: remove private alpha remnants while preserving every public workflow.
Spec: spec.md. Authorization: user approved cleanup and forbade broader release reduction.

- [x] Remove hosted skill/auth seams in skillLocal, policy, tokenStore, login, doctor/init/setup and obsolete research alpha guidance; preserve provider credentials and trust checks. Test ambient old credentials against bundled skills before/after.
- [x] Remove automatic remote telemetry/profile/operator dispatch and replace disclosures with local behavior. Test configured legacy credentials cannot cause requests; retain local logs and all adapters.
- [x] Remove remote bug transport and owner reporting assumptions, preserve report add/show/delete and existing local diagnostics. Test saved reports and rejection of send without any request.
- [x] Correct README/install/support documentation; test runtime claims and add CI matrix rather than shrink supported features.
- [x] Regenerate derived files/inventories, inspect scope, run full suite/public install/packet checks, obtain independent final review, commit and open PR. Invalidate old preparation; keep release pins unarmed.

Review focus: ambient credentials; local reports from older versions; provider key storage; caller-repository skill shadowing; exact artifact vs source build compatibility.
