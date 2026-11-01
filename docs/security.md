# Security

## Authentication & sessions
- Passwords: bcrypt (cost 12); minimum 8 characters with a letter and a number.
- Login: generic error messages, constant-time comparison against a dummy hash for
  unknown e-mails, rate limit (10 / 15 min / IP), lockout after 5 failures for 15 min.
- Sessions: JWT (HS256) whose `jti` must match a non-revoked row in `sessions`;
  logout revokes the session, password change revokes all sessions.
- Cookies: `token` is HTTP-only, `SameSite=Lax`, `Secure` in production.
- CSRF: double-submit — cookie-authenticated non-GET requests must send
  `X-CSRF-Token` equal to the `csrf_token` cookie. Bearer tokens bypass this
  (not sent automatically by browsers).
- 2FA: RFC 6238 TOTP, secret encrypted with AES-256-GCM (`TOTP_ENCRYPTION_KEY`),
  ±1 step drift. Optional per user; recommended for superadmins.

## Authorisation (deny by default)
`server/src/services/permissions.js` is the single source of truth:

| Permission | org_owner | manager | staff |
|---|:-:|:-:|:-:|
| org.read | ✓ | ✓ | ✓ |
| org.manage, org.members.manage, franchise.structure.manage, integrations.manage | ✓ | | |
| org.members.read, org.audit.read, franchise.financials.read, data.export, approvals.review, franchise.targets.manage, franchise.inventory.transfer | ✓ | ✓ | |
| franchise.read, franchise.sales.write, franchise.expenses.write, franchise.inventory.write, data.import | ✓ | ✓ | ✓ |

- **Tenant:** every org-scoped request checks an active membership in an active org.
- **Scope:** managers and staff only reach outlets in `outlet_assignments`; owners
  reach all outlets of their org. Filters (`brandId`, `regionId`, `outletId`) must
  belong to the same org.
- **Resources by id** are loaded, then authorised; foreign ids return 404.
- **Privilege escalation:** only `manager`/`staff` can be granted via the API;
  owners cannot change their own membership; `is_superadmin` is never writable.
- **Superadmin** manages the platform but has no implicit access to tenant financial
  data; platform audit views omit old/new values of org-scoped events.

## Application security
- Parameterised SQL everywhere; dynamic `ORDER BY` uses whitelists.
- express-validator on inputs; DB `CHECK` constraints as a second line.
- Helmet (CSP `default-src 'self'`, `frame-ancestors 'none'`, nosniff…), CORS
  restricted to `CLIENT_ORIGIN`, JSON body limit 1 MB, API rate limit.
- Error handler maps DB errors to safe messages; 5xx never include details.
- Frontend renders through an auto-escaping `html` template (XSS).
- Uploads: `.csv`/`.xlsx` only, ZIP signature check, size and row caps, formulas never
  evaluated; exports neutralise formula-like text (`=`, `+`, `-`, `@`).
- Logs redact authorization headers, cookies, passwords, tokens and secrets; provider
  URLs are logged without query strings.

## Audit trail
`audit_events` records logins (and failures, lockouts, TOTP failures), session
revocations, profile/password/2FA changes, member and role changes, organisation and
platform settings, portfolio and transaction create/update/delete (old + new values
+ reason), sales/expense/inventory changes, transfers, imports, exports, approvals and
admin actions. A trigger rejects `UPDATE`/`DELETE`. Sensitive keys are scrubbed.

## Financial change controls
Organisations can require approval for sales/expense corrections and deletions
(`settings.approvals`). Requests store original and proposed values plus a reason;
reviewers need `approvals.review`; with separation of duties a requester cannot
approve their own change.

## Secrets
Only `.env.example` is committed (`.gitignore` excludes `.env`). In production the app
refuses to start without `JWT_SECRET`. Seeded demo passwords are for local
development only (`DEMO_PASSWORD`), and the seed refuses to run in production.

## Production checklist
- `NODE_ENV=production`, strong `JWT_SECRET` and `TOTP_ENCRYPTION_KEY`, HTTPS,
  `TRUST_PROXY` behind a proxy, `DB_SSL=true` for remote databases.
- Do not run `db:seed`; create the first superadmin manually
  (`UPDATE users SET is_superadmin = TRUE WHERE email = …`) and enable 2FA.
- Run `npm audit` and keep dependencies updated; schedule `npm run db:backup`.
