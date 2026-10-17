# Contribute to Sayboard

Sayboard is an AAC communication board. Changes must preserve access to the person's existing board and predictable tile placement.

## Run the app

Use Node 24 LTS, npm and Python 3. Python assembles the browser's corresponding-source archives during production builds.

```sh
npm ci --ignore-scripts
npm run dev -- --port 5188
```

Open `http://127.0.0.1:5188`. No account or environment file is needed. See [self-hosting](docs/SELF-HOSTING.md) for production builds and optional account services.

## Propose a change

Use an issue to explain the problem and who it affects. Discuss substantial changes to communication controls, access methods or cloud permissions before implementation. Small fixes can go straight to a pull request.

Changes to `main` require a pull request, passing checks and approval from `@josephtwilliams`, the code owner for all files. New commits dismiss earlier approvals. The maintainer can merge their own pull requests without a second reviewer, but the required checks still apply. Force pushes and deletion of `main` are blocked.

Use synthetic vocabulary and demonstration accounts in issues, screenshots, fixtures and logs. Never include a person's real communication board, recordings, student details, credentials or database exports. Report security vulnerabilities through the [private reporting route](SECURITY.md).

Treat contributors and AAC users with respect. Describe observable problems and avoid assumptions about a person's communication ability.

## Check your work

Run the checks relevant to your change. The baseline checks are:

```sh
npm run check:public
npm run lint
npm run typecheck
npm test
npm run --prefix backend check
npm run build
npm run build:server
python3 scripts/verify-source.py
```

For a full publication audit, run `npm run check:public -- --history` from a complete Git clone. The audit reports locations and rule names without printing matched credentials. Read its limits in [the launch checklist](docs/OPEN-SOURCE-LAUNCH.md).

For changes affecting the free app, run the built-app check in a checkout without cloud environment settings:

```sh
npx playwright install chromium
npm run preview -- --port 5189
```

In another terminal, run:

```sh
npm run test:free-core
```

Inspect the actual interaction for UI changes. Keep board export and local saving available when account services fail. Never make speech or access to the locally saved board depend on a subscription.

For server or deployment changes, run the real HTTPS container check with Docker available:

```sh
docker build -t sayboard:publication-review .
node scripts/verify-vps.mjs
```

It creates isolated containers and synthetic accounts, checks browser restore, account isolation, restart, password reset and database restore, then removes its temporary volumes. Reports stay in ignored `test-results/`. Run `python3 -m unittest discover -s scripts -p 'test_public_readiness.py'` for publication tooling and the Python tests under `scripts/speech/release` for source packaging changes.

## Licence your contribution

By contributing, you confirm that you can grant the rights needed under the existing licences for the files you change. Original project code uses GPL-3.0-or-later. Original browser files covered by `LICENSE-OWNER-MIT` also retain that additional permission. Preserve third-party notices and identify any new dependency's licence. See [LICENSING.md](LICENSING.md).

Hosting, billing and classroom code belong in the public project. Production credentials and customer records stay outside it.
