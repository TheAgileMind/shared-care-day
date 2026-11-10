# Security policy

Shared Care Day is a small, self-hosted app for one household. It is a reference implementation, not a hosted service.

## Reporting a vulnerability

Please use GitHub's **private vulnerability reporting** (Security tab → "Report a vulnerability") on this repository. Do not open a public issue for security problems. Expect a reply within a week.

## Security model

- **Sign-in:** an allowlisted email (from `config.json`) plus one shared household PIN (`FAMILY_PIN`). The PIN is compared in constant time (SHA-256 digests + `timingSafeEqual`). The PIN is checked before the allowlist, so a caller without the PIN cannot probe which emails are invited.
- **Brute force:** in-memory limit of 8 attempts per 10 minutes per client IP and per email. This is per process; put a shared store in front if you run more than one instance.
- **Sessions:** an HMAC-SHA256-signed cookie (`care_session`) with `HttpOnly`, `SameSite=Lax`, `Secure` in production, 30-day expiry. The allowlist is re-checked on every request, so removing a caregiver from config revokes their access at the next restart. Rotating `SESSION_SECRET` signs everyone out.
- **CSRF:** the API only accepts JSON bodies, the cookie is `SameSite=Lax`, and CORS is same-origin unless `CORS_ORIGINS` is set.
- **Headers:** `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a restrictive `Permissions-Policy`, and in production a Content-Security-Policy and HSTS.
- **Input:** event types are an allowlist; times must parse as dates; per-event details are capped at 2 KB; a day is capped at 500 events; request bodies are capped at 32 KB.
- **Data:** day logs and the child profile live in `DATA_DIR` as JSON files and are never committed. `/api/*` responses are `Cache-Control: no-store`, and the service worker does not cache API data.

## Known limitations

- A shared PIN is a household convenience, not per-user credentials. Anyone with the PIN and an invited email can sign in as that caregiver. For stronger identity, swap in an OAuth/OIDC provider or magic links.
- Sessions are stateless; there is no per-session revoke short of rotating `SESSION_SECRET`.
- `trust proxy` defaults to one hop in production (Railway, Render, Fly). Set `TRUST_PROXY` to match your platform, or the per-IP limiter can be bypassed with a spoofed `X-Forwarded-For`.

## Operator checklist

- Use a long random `FAMILY_PIN` (not 4 digits) and a 32+ byte random `SESSION_SECRET`. Keep both in your host's secret store, never in git.
- Turn on GitHub secret scanning, push protection, and Dependabot for your fork.
- Keep `config.json` and `.env` out of git (they are in `.gitignore`).
