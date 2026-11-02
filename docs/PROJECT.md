# Sayboard project and hosting plan

Sayboard is a fully open-source product with optional paid official hosting. There is no private edition of the teacher dashboard or server. A technically capable person or school can run the published software themselves under its licences.

## Free communication app

The free app includes board creation, editing, speech, device saving, import and export. It requires no account. The free app can run on any static HTTPS host.

Keep the local communication path independent of account availability and billing. An expired session, cloud outage or subscription cancellation must never remove the working board from a device or prevent local speech and export. A hosted board must become a validated local copy before replacing a device's current board.

Browser storage is not a permanent backup. Offline startup and speech need device-specific verification before they can be advertised as guaranteed. Open-source distribution also allows someone else to host the app if the official service closes; it does not guarantee perpetual operation of one website.

## Optional official hosting

The proposed paid service handles teacher accounts, classroom permissions, saved boards, device linking, version history, hosting and backups. Student communication remains free. Start with one classroom plan and student access included rather than charging each student.

Personal cloud-backup pricing and classroom prices are undecided. The owner requested that these decisions follow a teacher pilot. Do not add a paywall, promise free unlimited cloud storage or publish a price before that decision.

Public source code does not make customer data public. Production records, credentials, support evidence and database backups remain private. The software licence permits self-hosting and commercial reuse; official-service terms govern the service people buy.

## Current implementation

| Capability                                       | Status                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Local boards, editing, speech, import and export | Implemented; see [device and offline limits](SELF-HOSTING.md#serve-only-the-static-app)                  |
| Standalone account backup                        | Implemented with SQLite, operator-created accounts, explicit save/load and revision checks               |
| Optional PostgreSQL adapter                      | Implemented against the same account storage contract                                                    |
| Classroom dashboard and ownership                | Implemented for one adult owner per classroom, with learner aliases and SQLite storage                   |
| Device pairing and published board updates       | Implemented with single-use codes, automatic updates at safe points, device receipts and version restore |
| Public teacher workspaces                        | Opt-in hosted SQLite signup, recovery kits and password recovery without an email provider               |
| Teacher invitations                              | Implemented with organiser permissions, single-use password setup and optional SMTP delivery             |
| Shared school organisations and delegated roles  | Planned                                                                                                  |
| Subscriptions and billing                        | Planned; prices undecided                                                                                |

Personal backups store one board copy per adult account. Classroom profiles, drafts, versions and device links are separate records. Each classroom belongs to one adult account; it cannot access another adult's personal backup or classrooms. See [the implemented boundaries](ARCHITECTURE.md#classroom-boundary).

## First teacher pilot

Prove this workflow before adding billing:

1. A teacher creates a classroom and a demonstration student profile without requiring a student email address.
2. The teacher creates or imports a board and previews it.
3. A caregiver deliberately links a device to that profile with an expiring, single-use pairing code and confirms automatic updates once.
4. The teacher publishes an immutable board version without touching the learner's device. The linked device receives it at a safe point, saves it locally and reports receipt. It keeps its last working version if a transfer fails.
5. The teacher restores a previous version. Removing device access stops future cloud transfers without deleting its working local board.

Keep drafts separate from published versions. An edit on the teacher dashboard must not rearrange tiles while the person is communicating. Store no history of what the student says. Record publication and permission changes without copying vocabulary into logs.

## Future school workspaces

The pilot implements adult-owned classrooms, learner profiles, drafts, versions and device links. The following organisation and membership model is a future extension, not an applied schema. Add it when the pilot demonstrates a need for teachers to collaborate.

| Record          | Owns                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Organisation    | A school or classroom workspace                                                                        |
| Membership      | An adult account's role in one organisation                                                            |
| Student profile | A workspace-specific label and board assignment, with no student login required for the pilot          |
| Board           | A teacher-editable draft and a pointer to its published version                                        |
| Board version   | An immutable, validated board snapshot with a revision and author                                      |
| Device link     | Scoped read access to one assigned profile, with revocation and expiring pairing credentials           |
| Subscription    | Official hosted-service entitlement for the organisation, separate from board ownership and membership |

An organisation extension must enforce membership on every read and write. The pilot already enforces classroom ownership on every operation. Device credentials only read assigned published versions. They cannot list students, edit boards or manage billing.

Keep subscription checks at hosted-service boundaries. Self-hosted deployments use the same classroom code without an official billing account. The local app does not know whether a classroom subscription is active.

## Delivery order

1. Prepare public licensing, contributor instructions, self-hosting, publication checks and a free-app browser check.
2. Review repository history and GitHub content, enable private vulnerability reporting, and publish the prepared project.
3. Verify operator provisioning, password reset, cross-device backup and restore with synthetic accounts.
4. Implement the classroom model, permissions and a small dashboard in the public repository.
5. Verify device pairing, safe publishing, rollback, cloud outages, account revocation and organisation isolation.
6. Run a teacher pilot. Agree the personal-backup policy and a sustainable classroom price using actual operating and support costs.
7. Add hosted subscriptions, cancellation behaviour, data retention, privacy terms and support arrangements before taking payments.

Repository publication and classroom implementation are complete. The next milestone is the teacher pilot, using [the documented workflow](TEACHER-PILOT.md). Optional Google sign-in and explicit self-service Google account provisioning are implemented but require operator OAuth configuration and a live school-account acceptance check before enabling. First-party teacher signup and single-use recovery kits are implemented for hosted SQLite. Signup is disabled by default and needs a separate host opt-in. The official deployment uses a standalone VPS at `classroom.sayboard.org`, with the free static app at `sayboard.org`. Organisers can share private invitations themselves or send them through standard SMTP. Teachers choose their own passwords and can recover with their saved code. Organiser resets remain available when both the password and recovery code are lost.
