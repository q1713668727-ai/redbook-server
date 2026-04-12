# Inferred Schema (From Code)

This is an inferred schema snapshot based on SQL used in `server/routes/*.js`.
It is intended as a maintenance reference, not as a strict DDL source.

## `login`

Referenced columns:

- identity: `account`, `email`, `name`, `password`, `avatar`
- profile: `about`, `birthday`, `sex`, `occupation`, `school`, `district`, `background`
- social: `attention`, `fans`, `following_accounts`, `follower_accounts`
- content refs: `likes`, `collects`
- auth: `auth_token`, `auth_token_expire_at`

## `note`

Referenced columns:

- base fields: `id`, `base`, `image`, `account`, `title`, `brief`, `date`, `likes`, `name`, `url`
- interaction fields: `comment`
- collect compatibility: `collects` (preferred), `collect` (legacy compatible)

## `video`

Referenced columns:

- base fields: `id`, `base`, `image`, `account`, `title`, `date`, `likes`, `name`, `url`, `comment`
- interaction fields: `location`
- collect compatibility: `collects` (preferred), `collect` (legacy compatible)

## `msg`

Referenced columns:

- `UserToUser`, `account`, `message`

