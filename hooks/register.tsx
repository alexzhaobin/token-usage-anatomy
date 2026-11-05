// token-usage-anatomy: the hooks module.
//
// M1 scaffold: pricing lives in pricing.ts and prices.ts. Event handling,
// logging and the band arrive in the next milestones; until then the
// module registers no hooks, so loading it changes nothing in a session.

import type { Register } from 'claude-code'

export const register: Register = () => {}
