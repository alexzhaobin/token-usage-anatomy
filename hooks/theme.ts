// Is the person's theme light or dark? The band uses one palette step for
// each. Pure decisions over what register.tsx reads; anything unclear
// counts as dark, Claude Code's default.

/** A built-in theme is light when its name says so (`light`, `light-daltonized`, ...). */
export function isBuiltInLight(theme: string): boolean {
  return /light/i.test(theme)
}

/** `custom:<slug>` themes live in `<claudeDir>/themes/<slug>.json`. */
export function customSlug(theme: string): string | undefined {
  const slug = theme.startsWith('custom:') ? theme.slice('custom:'.length) : undefined

  // A slug names a file in the themes folder: nothing that could leave it.
  return slug !== undefined && /^[A-Za-z0-9._-]+$/.test(slug) && !slug.startsWith('.') ? slug : undefined
}

/** A custom theme is light when its `base` is a light theme. */
export function isCustomLight(json: string): boolean {
  try {
    const base = (JSON.parse(json) as { base?: unknown }).base

    return typeof base === 'string' && isBuiltInLight(base)
  } catch {
    return false
  }
}

/** COLORFGBG ("15;0"): its last field is the background; 7 or 15 is light. */
export function lightFromColorFgBg(value: string | undefined): boolean | undefined {
  const background = value?.split(';').at(-1)?.trim()

  if (background === undefined || !/^\d+$/.test(background)) {
    return undefined
  }

  return background === '7' || background === '15'
}

/** macOS `defaults read -g AppleInterfaceStyle`: "Dark", or no such key in light mode. */
export function lightFromMacStyle(run: { exitCode: number; stdout: string; stderr: string }): boolean | undefined {
  if (run.exitCode === 0) {
    return /dark/i.test(run.stdout) ? false : undefined
  }

  return /does not exist/i.test(run.stderr + run.stdout) ? true : undefined
}

/** GNOME `gsettings get org.gnome.desktop.interface color-scheme`. */
export function lightFromGnome(stdout: string): boolean | undefined {
  if (/prefer-dark/.test(stdout)) {
    return false
  }

  if (/prefer-light|'default'/.test(stdout)) {
    return true
  }

  return undefined
}

/** Windows `reg query ...\Personalize /v AppsUseLightTheme`. */
export function lightFromWindows(stdout: string): boolean | undefined {
  const match = /AppsUseLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout)

  return match === null ? undefined : match[1] !== '0'
}
