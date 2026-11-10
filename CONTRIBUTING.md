# Contributing

Thanks for taking a look. This is a small personal project; issues and focused pull requests are welcome.

## Local setup

```bash
npm install
cp .env.example .env              # set FAMILY_PIN and SESSION_SECRET
cp config.example.json config.json
npm run dev                       # API on :3001, Vite client on :8080
```

## Before you open a PR

```bash
npm run typecheck
npm test
npm run build
```

CI runs the same steps plus `npm audit` and a gitleaks secret scan.

## Ground rules

- **No real household data.** Use the fictional demo household (Sam; Alex, Jordan, Casey, Taylor, Morgan at `@example.com`). Never commit names, emails, birth dates, photos, or day logs of real people.
- Keep schedule guidance generic. Do not paste text, tables, or branding from commercial sleep programs.
- Add or update tests for behavior changes. The suite uses Node's built-in test runner via `tsx --test`.
- Keep English and Spanish strings in sync (`src/lib/i18n.ts`; a test enforces this).
