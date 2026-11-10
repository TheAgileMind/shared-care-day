/** Generic initials avatar. No photos are bundled with the app. */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'SC'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function initialsAvatar(name: string): string {
  const initials = initialsOf(name)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="64" fill="#c4a484"/>
  <text x="64" y="76" text-anchor="middle" font-family="Georgia, 'Times New Roman', serif" font-size="48" font-weight="700" fill="#f7f3ee">${initials}</text>
</svg>`
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}
