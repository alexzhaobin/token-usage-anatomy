// Short numbers for the band: dollars, token counts and countdowns.

/** `$123`, `$12.3`, `$0.12`, `$0.123`, `<$0.001`, `$0`. */
export function money(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) {
    return '$0'
  }

  if (usd >= 100) {
    return `$${Math.round(usd)}`
  }

  if (usd >= 10) {
    return `$${usd.toFixed(1)}`
  }

  if (usd >= 0.1) {
    return `$${usd.toFixed(2)}`
  }

  if (usd >= 0.001) {
    return `$${usd.toFixed(3)}`
  }

  return '<$0.001'
}

const oneDecimal = (value: number): string => String(Math.round(value * 10) / 10)

/** `8200` is `8.2k`, `150000` is `150k`, `1000000` is `1M`. */
export function tokensShort(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return '0'
  }

  if (tokens >= 999_950) {
    const millions = tokens / 1_000_000

    return `${millions >= 100 ? Math.round(millions) : oneDecimal(millions)}M`
  }

  if (tokens >= 1_000) {
    const thousands = tokens / 1_000

    return `${thousands >= 100 ? Math.round(thousands) : oneDecimal(thousands)}k`
  }

  return String(Math.round(tokens))
}

/** `4:59`, or `1:00:00` from an hour up. */
export function countdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const ss = String(s).padStart(2, '0')

  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** `2.0%` of a whole, one decimal. */
export function percent(part: number, whole: number): string {
  return whole > 0 ? `${(Math.round((part / whole) * 1000) / 10).toFixed(1)}%` : '0%'
}
