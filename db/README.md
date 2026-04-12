# Database Optimization Notes

This folder contains non-breaking schema optimization helpers for the current project.

## Goals

- Keep existing API behavior unchanged.
- Improve query performance on high-frequency endpoints.
- Keep old and new column naming compatible (`collect` and `collects`).

## How To Apply

Run from `server` directory:

```bash
npm run db:optimize
```

The script is idempotent:

- Existing columns are kept.
- Missing columns are added only once.
- Existing indexes are kept.
- Missing indexes are added only once.

## What It Adds

- Compatibility columns in `note`/`video`: `collects` (and data sync from `collect` when present).
- Authentication and relationship support columns in `login` if missing.
- Common query indexes:
  - `login(account, email, auth_token)`
  - `msg(UserToUser, account)`
  - `note(account, date, account+date)`
  - `video(account, date, account+date)`

