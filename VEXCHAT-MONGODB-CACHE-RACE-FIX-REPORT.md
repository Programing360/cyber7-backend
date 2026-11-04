# VexChat Backend — MongoDB Connection Cache Race Fix Report

## Status

**COMPLETE**

The stale-attempt cache race in `src/config/database.ts` has been fixed and covered by isolated unit tests. No live MongoDB/Atlas connection was used.

## Root Cause

The previous cache cleanup compared only the MongoDB URI:

```ts
if (cachedConnection?.uri === mongoUri) {
  cachedConnection = null;
}
```

If an older connection attempt for the same URI failed after a newer attempt had replaced the cache, the older failure cleared the newer promise. A subsequent request then started an extra connection attempt.

The module-level `disconnected` listener also cleared whatever happened to be cached at the time, without checking which cache entry the event belonged to.

## Fix

File changed: `src/config/database.ts`

Each cache entry now owns:

- Its URI and promise.
- Its own `disconnected` handler.
- An identity that is checked before the entry can clear the cache.

Behavior:

- A cached entry is reused for the same URI while its promise is in flight or resolved.
- A failed attempt clears the cache only when `cachedConnection === connection` for that exact attempt.
- A `disconnected` event clears the cache only when the event belongs to the currently cached entry.
- When a newer attempt supersedes an older one, the older handler is removed.
- If an older handler is invoked late, it cannot clear the newer cache entry.
- A genuine disconnect clears the current entry, allowing the next request to reconnect.
- Existing connection options and the Vercel serverless entry point are unchanged.

## Tests Added / Updated

File changed: `tests/vercel-hardening.test.ts`

Coverage now includes:

1. Concurrent requests share one connection attempt.
2. A failed attempt clears its own cache so a later request retries.
3. An older same-URI failed attempt cannot clear a newer promise.
4. A stale disconnect event cannot clear a newer cache entry.
5. A later request reconnects after the current connection genuinely disconnects.
6. Missing `MONGODB_URI` still rejects as before.

The tests use mocked `mongoose.connect` calls and simulated disconnect events. No live Atlas database is required.

## Verification

| Command | Result | Exit code |
|---|---|---|
| `npm run typecheck` | No TypeScript diagnostics | `0` |
| `npm test` | 100 tests, 25 suites, 100 passed, 0 failed, 0 cancelled, 0 skipped, 0 todo | `0` |
| `npm run build` | Build completed successfully | `0` |
| `git diff --check` | No whitespace errors; only existing CRLF warning messages | `0` |

## Scope and Restrictions

- No deployment was performed.
- No commit, push, stage, or revert was performed.
- No unrelated application modules were modified.
- The Vercel API entry point (`api/index.ts`) and routing were not changed.
- MongoDB URI configuration and application architecture were not changed.

## Notes

- The repository already contained uncommitted Phase 4 and Vercel-hardening work before this fix.
- This fix is limited to the MongoDB cache implementation and its tests.
- The report file is separate from runtime code and was not deployed or committed.
