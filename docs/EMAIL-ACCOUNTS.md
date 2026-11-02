# Teacher email lifecycle

New teachers prove mailbox ownership before an account exists. A companion `account_emails` table owns verified identity. The existing `accounts` table and classroom ownership remain unchanged. Google identities still use immutable Google subjects. Invitation delivery addresses confer no identity authority.

`SqliteSelfService` owns issuance, inspection, completion, and credential invalidation. The API parses input, applies origin and CSRF checks, admits password work, sends SMTP, and installs cookies. There is no extra service layer because those responsibilities fit the existing owners.

Signup grants contain no account or password. Reset grants capture an eligible account and a digest of its credential hash, or a permanently unavailable target. Link grants capture the account and credential digest inside the issuance transaction. Completion rechecks the proof, uniqueness, eligibility, credentials, and any required session under `BEGIN IMMEDIATE`. Account creation, capacity checks, identity insertion, proof consumption, and new sessions commit together. A failure rolls all changes back.

Link requests require a session and CSRF. Link completion requires a current session for the named account and its current password. The original session may expire or sign out. This permits another device without allowing a forwarded link to attach a victim's mailbox to an attacker's account.

Reset issues a fresh session after mailbox proof and password selection, matching recovery-kit semantics. It revokes all previous sessions, kits, operator reset grants, and account-bound email grants in the same transaction. Existing conditional password-session insertion prevents a login verified before reset from creating a session afterward. Classrooms and device links are preserved.

The legacy login payload remains `{username,password}`. The server interprets that field as a username or verified email. There is no second identifier alias. Email normalization trims and lowercases the accepted ASCII address. It does not infer provider aliases.

At most two public account emails are sent concurrently. Excess requests receive 429 before a proof or SMTP transport is created. Email request limits use a separate table so mail cannot consume the legacy recovery limiter's key capacity. Requests reserve host, peer, recipient-hour, and recipient-cooldown budgets atomically. The limits are 100 per host and 10 per peer per five minutes, three per recipient per hour, and one per recipient per minute. Storage is bounded to 2,048 active limiter keys, 1,000 live grants, and three grants per purpose and recipient. Expired records are pruned during issuance. Live counters and proofs are never evicted to make room.

Every admitted signup or reset request sends a neutral action message, including duplicate signup and unknown reset addresses. This removes the large account-dependent SMTP timing branch. It does not promise constant-time behavior. An unknown reset target never gains authority if the email is linked later.

Only token hashes persist. Raw proofs exist in memory and the outgoing email. Failed or ambiguous SMTP delivery preserves the grant and spends its budget. There is no plaintext outbox or automatic retry worker. Reopening an email works until expiry or successful completion. Replaying a consumed link never reissues a session. After a lost completion response, the teacher signs in with the chosen password.

The browser reads a fragment once and immediately removes it from history. Inspection is read-only. A separate form submission performs completion. Proofs and passwords stay out of browser storage, analytics, API response links, and diagnostics. Sanitized delivery failures contain no provider error or recipient.

The self-host default remains username signup. Verified-email mode is an explicit configuration choice. SMTP availability never controls existing email login or recovery-kit access. No paid service, vendor SDK, pending-account permission state, or separate migration command is required. The schema additions happen when SQLite opens. Production rollout and independent parent/head verification remain separate operator work.
