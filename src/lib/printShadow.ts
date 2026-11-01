/**
 * The text shadow for a voucher whose picture fills the card (#419).
 *
 * The stall's picture is drawn behind every word on the card, and a picture can be anything: a
 * logo on a white background puts the default white text on white. So every printed character
 * gets a shadow, a tight edge plus a soft halo, that separates it from whatever is behind it.
 *
 * The shadow CONTRASTS WITH THE TEXT rather than being a fixed black. The foreground colour is
 * the merchant's own (`foregroundColor`, data rather than theme), and a black halo under dark
 * text would only thicken it. Light text gets a dark shadow, dark text a light one.
 *
 * Accepts the `rgb(r,g,b)` strings `pass.ts` produces and `#rgb` / `#rrggbb`. Anything else is
 * treated as light text, the default (white), so an unreadable colour still gets a dark shadow.
 */

function channels(color: string): [number, number, number] | null {
  const rgb = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i.exec(color.trim())
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())
  if (!hex) return null
  const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = Math.min(255, c) / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

/** Is this text colour light (so it needs a dark shadow)? Unparseable counts as light. */
export function isLightText(foreground: string): boolean {
  const c = channels(foreground)
  return c === null || luminance(c) > 0.18
}

/** A CSS `text-shadow` that keeps `foreground` text readable on any picture. */
export function printShadow(foreground: string): string {
  const tone = isLightText(foreground) ? '0,0,0' : '255,255,255'
  // Strong enough for the card's smallest print: the labels are drawn at 0.55 to 0.7 opacity, and
  // opacity fades a text's shadow along with its glyphs.
  return [
    `0 0 1px rgba(${tone},1)`,
    `0 0 2px rgba(${tone},0.9)`,
    `0 1px 3px rgba(${tone},0.8)`,
    `0 0 10px rgba(${tone},0.6)`,
  ].join(', ')
}
