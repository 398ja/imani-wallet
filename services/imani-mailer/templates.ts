/**
 * Declarative email templates (imani-mailer, #410).
 *
 * A template is DATA: a subject, a text body and the fields it may use, each with a type. Callers
 * send field values, never markup, subjects or addresses for headers. Rendering is the only place
 * a value meets the message, and every value passes its type's rules on the way:
 *
 * - `line`  one line of plain text. CR, LF and every other control character are removed, so no
 *           value can start a new header line (the subject is built from these).
 * - `text`  multi-line plain text (a gift message). Line breaks kept, other control chars removed.
 * - `url`   a link, checked against the link policy (scheme, host allow-list, no userinfo). Allowed
 *           in the BODY only: a URL can carry a secret in its fragment, and subjects show up in
 *           notifications, previews and server logs.
 * - `email` an address, syntax-checked. Body only, for the same reason.
 *
 * Syntax: `{{name}}` inserts a field, `{{#name}}…{{/name}}` keeps its contents only when the field
 * has a value, `{{^name}}…{{/name}}` only when it has none. Nothing else: no expressions, no
 * partials, no raw HTML. Templates are validated when they LOAD, so a typo in a placeholder fails
 * the boot rather than the first email.
 *
 * The HTML part, when on, is generated from the same token stream as the text: literals and values
 * are escaped, url fields become anchors whose href is the checked URL itself. No tracking pixels,
 * no rewritten links, so a claim URL's fragment reaches the recipient untouched (G-R4).
 */

export type FieldType = 'line' | 'text' | 'url' | 'email'

export interface FieldDef {
  type: FieldType
  required?: boolean
  /** Maximum length after cleaning. Defaults per type. */
  max?: number
  /** Used when the caller sends nothing (or only whitespace). Not allowed for url fields. */
  default?: string
}

export interface TemplateDef {
  subject: string
  text: string
  /** Generate an HTML alternative from the text (default true). */
  html?: boolean
  /** Display name for From on this template; the address is always the service's. */
  fromName?: string
  fields: Record<string, FieldDef>
}

export interface LinkPolicy {
  /** Exact `host[:port]` values links may point at. */
  hosts: readonly string[]
  /** Accept `http:` as well as `https:` (local development only; refused in production). */
  allowHttp: boolean
}

export interface Rendered {
  subject: string
  text: string
  html: string | null
  fromName: string | null
}

export class TemplateError extends Error {}

const DEFAULT_MAX: Record<FieldType, number> = { line: 200, text: 2000, url: 2048, email: 254 }
const NAME = /^[a-z][a-zA-Z0-9_]{0,63}$/
const TEMPLATE_NAME = /^[a-z][a-z0-9-]{0,63}$/

// eslint-disable-next-line no-control-regex -- removing control characters is the point
const CONTROL_ALL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g
// eslint-disable-next-line no-control-regex -- as above, keeping \n and \t
const CONTROL_KEEP_LF = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u2028\u2029]/g
// Bidi overrides and isolates: they can make a link or amount read differently from what it is.
const BIDI = /[\u202A-\u202E\u2066-\u2069]/g

export const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/

export function isEmail(value: string): boolean {
  return value.length <= 254 && EMAIL.test(value) && !value.includes('..')
}

/** One line: every control character (CR and LF included) becomes a space, then whitespace collapses. */
export function cleanLine(value: string, max: number): string {
  return value.replace(BIDI, '').replace(CONTROL_ALL, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim()
}

/** Multi-line: CRLF/CR become LF, other control characters go, at most two blank lines in a row. */
export function cleanText(value: string, max: number): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(BIDI, '')
    .replace(CONTROL_KEEP_LF, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max)
    .trim()
}

/** A checked link, or null. `href` of the parsed URL, so what is sent is what was checked. */
export function checkUrl(value: string, policy: LinkPolicy): string | null {
  let u: URL
  try {
    u = new URL(value)
  } catch {
    return null
  }
  if (u.protocol !== 'https:' && !(policy.allowHttp && u.protocol === 'http:')) return null
  if (u.username || u.password) return null
  if (!policy.hosts.includes(u.host.toLowerCase())) return null
  return u.href
}

type Token =
  | { kind: 'lit'; text: string }
  | { kind: 'var'; name: string }
  | { kind: 'section'; name: string; inverted: boolean; body: Token[] }

function parse(source: string, where: string): Token[] {
  const root: Token[] = []
  const stack: Array<{ name: string; tokens: Token[] }> = [{ name: '', tokens: root }]
  const re = /\{\{\s*([#^/]?)\s*([^}\s]*)\s*\}\}/g
  let last = 0
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const top = stack[stack.length - 1]
    if (m.index > last) top.tokens.push({ kind: 'lit', text: source.slice(last, m.index) })
    last = re.lastIndex
    const [, sigil, name] = m
    if (!NAME.test(name)) throw new TemplateError(`${where}: bad placeholder "{{${sigil}${name}}}"`)
    if (sigil === '#' || sigil === '^') {
      const body: Token[] = []
      top.tokens.push({ kind: 'section', name, inverted: sigil === '^', body })
      stack.push({ name, tokens: body })
    } else if (sigil === '/') {
      if (stack.length === 1 || top.name !== name) throw new TemplateError(`${where}: unexpected {{/${name}}}`)
      stack.pop()
    } else {
      top.tokens.push({ kind: 'var', name })
    }
  }
  if (stack.length > 1) throw new TemplateError(`${where}: {{#${stack[stack.length - 1].name}}} is never closed`)
  if (last < source.length) stack[0].tokens.push({ kind: 'lit', text: source.slice(last) })
  if (/\{\{|\}\}/.test(source.replace(re, ''))) throw new TemplateError(`${where}: stray braces`)
  return root
}

function names(tokens: Token[], into = new Set<string>()): Set<string> {
  for (const t of tokens) {
    if (t.kind === 'var') into.add(t.name)
    if (t.kind === 'section') {
      into.add(t.name)
      names(t.body, into)
    }
  }
  return into
}

export interface CompiledTemplate {
  name: string
  def: TemplateDef
  subject: Token[]
  text: Token[]
}

/** Validate and compile. Throws TemplateError naming the template and the problem. */
export function compile(name: string, def: TemplateDef): CompiledTemplate {
  if (!TEMPLATE_NAME.test(name)) throw new TemplateError(`template name "${name}" is not [a-z0-9-]`)
  if (!def || typeof def.subject !== 'string' || typeof def.text !== 'string' || typeof def.fields !== 'object' || !def.fields) {
    throw new TemplateError(`${name}: needs subject, text and fields`)
  }
  if (/[\r\n]/.test(def.subject)) throw new TemplateError(`${name}: the subject is one line`)
  if (def.fromName !== undefined && (typeof def.fromName !== 'string' || cleanLine(def.fromName, 80) !== def.fromName)) {
    throw new TemplateError(`${name}: fromName must be one short line`)
  }
  for (const [field, f] of Object.entries(def.fields)) {
    if (!NAME.test(field)) throw new TemplateError(`${name}: bad field name "${field}"`)
    if (!f || !['line', 'text', 'url', 'email'].includes(f.type)) throw new TemplateError(`${name}.${field}: unknown type`)
    if (f.max !== undefined && (!Number.isInteger(f.max) || f.max < 1 || f.max > 10_000)) throw new TemplateError(`${name}.${field}: bad max`)
    if (f.default !== undefined && (f.type === 'url' || typeof f.default !== 'string')) throw new TemplateError(`${name}.${field}: bad default`)
  }
  const subject = parse(def.subject, `${name}.subject`)
  const text = parse(def.text, `${name}.text`)
  for (const used of names(subject)) {
    const f = def.fields[used]
    if (!f) throw new TemplateError(`${name}.subject uses undeclared field "${used}"`)
    if (f.type === 'url' || f.type === 'email' || f.type === 'text') {
      throw new TemplateError(`${name}.subject may not use ${f.type} field "${used}" (subjects leak into previews and logs)`)
    }
  }
  for (const used of names(text)) {
    if (!def.fields[used]) throw new TemplateError(`${name}.text uses undeclared field "${used}"`)
  }
  return { name, def, subject, text }
}

/** Clean and check every declared field. Undeclared fields are refused, not ignored. */
export function resolveFields(t: CompiledTemplate, input: Record<string, unknown>, links: LinkPolicy): Map<string, string> {
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(t.def.fields, key)) throw new TemplateError(`unknown field "${key}" for ${t.name}`)
  }
  const out = new Map<string, string>()
  for (const [field, f] of Object.entries(t.def.fields)) {
    const raw = Object.hasOwn(input, field) ? input[field] : undefined
    if (raw !== undefined && raw !== null && typeof raw !== 'string') throw new TemplateError(`${field} must be a string`)
    const max = f.max ?? DEFAULT_MAX[f.type]
    let value = ''
    if (typeof raw === 'string') {
      if (f.type === 'url') {
        const trimmed = raw.trim()
        if (trimmed) {
          if (trimmed.length > max) throw new TemplateError(`${field} is too long`)
          const checked = checkUrl(trimmed, links)
          if (!checked) throw new TemplateError(`${field} must be a link to an allowed host`)
          value = checked
        }
      } else if (f.type === 'email') {
        const trimmed = raw.trim()
        if (trimmed && !isEmail(trimmed)) throw new TemplateError(`${field} must be an email address`)
        value = trimmed
      } else {
        value = f.type === 'text' ? cleanText(raw, max) : cleanLine(raw, max)
      }
    }
    if (!value && f.default !== undefined) value = f.default
    if (!value && f.required) throw new TemplateError(`${field} is required`)
    out.set(field, value)
  }
  return out
}

const HTML_ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
}

function renderTokens(tokens: Token[], values: Map<string, string>, emit: (t: Token & { kind: 'lit' | 'var' }) => string): string {
  let out = ''
  for (const t of tokens) {
    if (t.kind === 'section') {
      const has = (values.get(t.name) ?? '') !== ''
      if (has !== t.inverted) out += renderTokens(t.body, values, emit)
    } else {
      out += emit(t)
    }
  }
  return out
}

/** Render a compiled template with already-resolved fields. */
export function render(t: CompiledTemplate, values: Map<string, string>): Rendered {
  const plain = (tok: Token & { kind: 'lit' | 'var' }) => (tok.kind === 'lit' ? tok.text : values.get(tok.name) ?? '')
  const subject = cleanLine(renderTokens(t.subject, values, plain), 250)
  if (!subject) throw new TemplateError(`${t.name}: the subject rendered empty`)
  const text = renderTokens(t.text, values, plain).replace(/\n{3,}/g, '\n\n').trim() + '\n'
  let html: string | null = null
  if (t.def.html !== false) {
    const inner = renderTokens(t.text, values, (tok) => {
      if (tok.kind === 'lit') return escapeHtml(tok.text)
      const v = values.get(tok.name) ?? ''
      if (t.def.fields[tok.name].type === 'url' && v) {
        const e = escapeHtml(v)
        return `<a href="${e}">${e}</a>`
      }
      return escapeHtml(v)
    })
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const paragraphs = inner
      .split(/\n\n/)
      .map((p) => `<p>${p.replace(/\n/g, '<br>\n')}</p>`)
      .join('\n')
    html =
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
      '<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1a1a1a">\n' +
      paragraphs +
      '\n</body></html>\n'
  }
  return { subject, text, html, fromName: t.def.fromName ?? null }
}

/** The field list a caller may ask for (GET /v1/templates). */
export function describe(t: CompiledTemplate): { name: string; fields: Record<string, { type: FieldType; required: boolean }> } {
  return {
    name: t.name,
    fields: Object.fromEntries(Object.entries(t.def.fields).map(([k, f]) => [k, { type: f.type, required: !!f.required }])),
  }
}
