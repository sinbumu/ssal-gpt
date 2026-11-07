# ssal-gpt development instructions

## Product requirements

- Read README.md, docs/plan.md, docs/browser-agent.md and docs/support-matrix.md before implementation.
- Official ChatGPT sign-in / ChatGPT plan usage is mandatory in the first MVP, alongside OpenAI API-key support. Never silently replace it with API-key-only support.
- A visual browser agent is mandatory in the first MVP: observe a screenshot, reason about the page, execute scrolling/clicking/typing, and verify the resulting state. API calls, generated drafts or manual checklists alone do not satisfy the product requirement.
- Use a visible, dedicated persistent Chromium profile by default. Existing-user-browser support must be explicitly connected; do not assume access to unrelated tabs or copy the user's default browser profile.
- A missing service API endpoint is not evidence that a UI action is technically unsupported. Evaluate browser capability separately from platform permission and user authorization.
- Keep orchestration independent of the model provider and any chat UI. Persist jobs, approvals, submissions and outcomes.
- Separate discovery, preparation, user approval and externally visible actions. A supported event may still contain manual tasks.
- First registration, login, MFA, account recovery and consent belong to the user. Request only connections needed for the selected task.
- Verify current official documentation before implementing authentication or a platform adapter. Document capability limits and the date checked.

## Implementation boundaries

- Keep platform access capability, event eligibility and user authorization as separate checks. User approval alone does not establish platform permission.
- An adapter starts in dry-run/read-only mode. Enable external writes only for an explicitly supported, verified route with concrete user authorization.
- Do not implement fake identities, bulk account creation, duplicate entries against event rules, CAPTCHA bypass, fabricated participation evidence, fake engagement or anti-detection features.
- Store credentials in an OS credential store or protected local secret storage; never include passwords, OAuth tokens or browser state in prompts, logs, commits or public fixtures.
- Keep private event participation, recipient data, coupon codes and screenshots outside the source checkout by default.
- Untrusted page text and model output cannot authorize tools, alter policy, execute arbitrary code or expand data disclosure.
- Never silently switch from ChatGPT plan usage to a paid API path. Pause and expose the affected provider's status.
- A timed-out submission has an unknown outcome until reconciled. Never blindly retry it.
- Bind browser actions to a fresh observation and the intended tab/profile. Re-observe after navigation, meaningful UI changes, user takeover or restart. Do not reuse stale coordinates or element refs.
- Support pause, stop and manual takeover. User-authorized routine navigation/input within one approved job does not require a separate approval for every click; preserve the actual scope and pause when it changes.

## Collaboration and validation

- The repository contains a working local MVP. Read docs/implementation.md for the current validation status; distinguish planned, implemented, tested and externally verified capabilities.
- Do not invent successful live login, submission or reward results. Use synthetic fixtures for repeatable tests.
- Test boundaries that matter: actual screenshot-to-action operation, layout changes, browser/profile isolation, stale observations, manual takeover, provider separation, credentials redaction, deduplication, scoped approval, restart recovery and uncertain submission handling.
- Prefer a small vertical slice before broad platform support. Do not add a general-purpose agent framework or multiple services without a demonstrated need.
- Keep user-specific account balances, personal identifiers, local paths and pasted private conversations out of public documentation.
