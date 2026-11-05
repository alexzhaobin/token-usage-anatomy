// Constants for the session values. The values themselves are atoms in
// register.tsx (the engine reads each atom off the file that uses it);
// their types are in ../types/index.d.ts.

import type { CacheClock } from '../types'

/** The band keeps at most this many prompts' bars. */
export const MAX_ROWS = 60

export const FIVE_MINUTES = 5 * 60 * 1000
export const ONE_HOUR = 60 * 60 * 1000

/** Before the first request: no expiry, and the shorter lifetime, so it errs cold. */
export const initialCache: CacheClock = { expiresAt: null, ttlMs: FIVE_MINUTES, now: 0 }
