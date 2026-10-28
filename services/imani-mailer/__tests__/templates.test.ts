import { describe, expect, it } from 'vitest'

import { BUILTIN_TEMPLATES } from '../builtins'
import { checkUrl, cleanLine, cleanText, compile, escapeHtml, isEmail, render, resolveFields, TemplateError, type TemplateDef } from '../templates'
import { CLAIM_SECRET, claimFields } from './fixtures'

const LINKS = { hosts: ['wallet.imani.test', 'imani.test'], allowHttp: false }
const claim = compile('gift-claim', BUILTIN_TEMPLATES['gift-claim'])
const renderClaim = (fields: Record<string, unknown>) => render(claim, resolveFields(claim, fields, LINKS))

describe('built-in templates', () => {
  it('every built-in compiles', () => {
    for (const [name, def] of Object.entries(BUILTIN_TEMPLATES)) expect(() => compile(name, def)).not.toThrow()
  })

  it('the claim email: the link and its secret are in the body only, never the subject', () => {
    const r = renderClaim(claimFields)
    expect(r.subject).toBe('Alice sent you a voucher for Card Test Bakery')
    expect(r.subject).not.toContain(CLAIM_SECRET)
    expect(r.text).toContain(`https://wallet.imani.test/claim#${CLAIM_SECRET}`)
    expect(r.text).toContain('Happy birthday!')
    expect(r.text).toMatch(/Don't forward it/)
    expect(r.text).toMatch(/never asks for card details or passwords/)
    expect(r.html).toContain(`<a href="https://wallet.imani.test/claim#${CLAIM_SECRET}">`)
  })

  it('a missing optional section is dropped cleanly, and a default fills an empty field', () => {
    const r = renderClaim({ ...claimFields, message: '', from: '  ' })
    expect(r.subject).toBe('Someone sent you a voucher for Card Test Bakery')
    expect(r.text).not.toMatch(/\n\n\n/)
    expect(r.text).toMatch(/voucher for Card Test Bakery\.\n\nClaim it by/)
  })

  it('gift-expiring (G13): no link field at all, so no claim link can ever be sent; points to the claim email', () => {
    const t = compile('gift-expiring', BUILTIN_TEMPLATES['gift-expiring'])
    expect(Object.values(t.def.fields).some((f) => f.type === 'url')).toBe(false)
    const fields = { from: 'Alice', stall: 'Card Test Bakery', amount: '£5.00', claimBy: '27 Nov 2026', sentOn: '28 Oct 2026', sender: 'gifts@imani.casa', claimSubject: 'Alice sent you a voucher for Card Test Bakery' }
    const r = render(t, resolveFields(t, fields, LINKS))
    expect(r.subject).toBe('Your voucher for Card Test Bakery expires soon')
    expect(r.text).toContain('our email of 28 Oct 2026 from gifts@imani.casa')
    expect(r.text).toContain('"Alice sent you a voucher for Card Test Bakery"')
    expect(r.text).toMatch(/spam/)
    expect(r.text).not.toMatch(/https?:/)
    expect(r.html).not.toMatch(/<a /)
    expect(() => resolveFields(t, { ...fields, claimUrl: claimFields.claimUrl }, LINKS)).toThrow(/unknown field "claimUrl"/)
  })

  it('refuses missing required fields, unknown fields and non-strings', () => {
    expect(() => renderClaim({ ...claimFields, stall: '' })).toThrow(/stall is required/)
    expect(() => renderClaim({ ...claimFields, bcc: 'x@y.z' })).toThrow(/unknown field "bcc"/)
    expect(() => renderClaim({ ...claimFields, amount: 5 })).toThrow(/must be a string/)
  })
})

describe('header and content injection', () => {
  it('CR/LF in a subject field cannot start a header', () => {
    const r = renderClaim({ ...claimFields, from: 'Eve\r\nBcc: victim@example.com\r\nX-Evil: 1' })
    expect(r.subject).not.toMatch(/[\r\n]/)
    expect(r.subject).toBe('Eve Bcc: victim@example.com X-Evil: 1 sent you a voucher for Card Test Bakery')
  })

  it('unicode line separators, NUL and bidi overrides are removed', () => {
    expect(cleanLine('a\u2028b\u0000c\u202Ed', 100)).toBe('a b cd')
    expect(cleanText('line1\r\nline2\u0007\n\n\n\nline3\u2066', 100)).toBe('line1\nline2\n\nline3')
  })

  it('HTML in any field is escaped in the HTML part, kept literal in the text part', () => {
    const r = renderClaim({ ...claimFields, message: '<img src=x onerror=alert(1)> & "quotes"' })
    expect(r.html).toContain('&lt;img src=x onerror=alert(1)&gt; &amp; &quot;quotes&quot;')
    expect(r.html).not.toContain('<img')
    expect(r.text).toContain('<img src=x onerror=alert(1)> & "quotes"')
    expect(escapeHtml(`'`)).toBe('&#39;')
  })

  it('lengths are capped after cleaning', () => {
    const r = renderClaim({ ...claimFields, message: 'x'.repeat(5000) })
    expect(r.text).toContain('x'.repeat(280))
    expect(r.text).not.toContain('x'.repeat(281))
  })
})

describe('links', () => {
  it('only https links to an allowed host', () => {
    expect(checkUrl('https://wallet.imani.test/claim#abc', LINKS)).toBe('https://wallet.imani.test/claim#abc')
    expect(checkUrl('http://wallet.imani.test/claim', LINKS)).toBeNull()
    expect(checkUrl('https://evil.test/claim', LINKS)).toBeNull()
    expect(checkUrl('https://wallet.imani.test.evil.test/', LINKS)).toBeNull()
    expect(checkUrl('https://user:pw@wallet.imani.test/', LINKS)).toBeNull()
    expect(checkUrl('javascript:alert(1)', LINKS)).toBeNull()
    expect(checkUrl('data:text/html,hi', LINKS)).toBeNull()
    expect(checkUrl('//wallet.imani.test/x', LINKS)).toBeNull()
    expect(checkUrl('https://WALLET.imani.test/x', LINKS)).toBe('https://wallet.imani.test/x')
  })

  it('http only when the policy allows it', () => {
    expect(checkUrl('http://localhost:5173/claim#a', { hosts: ['localhost:5173'], allowHttp: true })).toBe('http://localhost:5173/claim#a')
    expect(checkUrl('http://localhost:5174/claim#a', { hosts: ['localhost:5173'], allowHttp: true })).toBeNull()
  })

  it('a link to another host fails the render instead of being sent', () => {
    expect(() => renderClaim({ ...claimFields, claimUrl: 'https://phish.test/claim#x' })).toThrow(TemplateError)
  })

  it('a quote in a URL cannot break out of the href', () => {
    const r = renderClaim({ ...claimFields, claimUrl: 'https://wallet.imani.test/claim#a"onmouseover="x' })
    expect(r.html).not.toContain('"onmouseover="')
  })
})

describe('compile refuses unsafe or broken templates at load', () => {
  const base: TemplateDef = { subject: 'Hi {{name}}', text: 'Hello {{name}}', fields: { name: { type: 'line' } } }
  it('a url, email or multi-line field in the subject', () => {
    expect(() => compile('t', { ...base, subject: '{{u}}', fields: { u: { type: 'url' } } })).toThrow(/subject may not use url/)
    expect(() => compile('t', { ...base, subject: '{{e}}', fields: { e: { type: 'email' } } })).toThrow(/subject may not use email/)
    expect(() => compile('t', { ...base, subject: '{{m}}', fields: { m: { type: 'text' } } })).toThrow(/subject may not use text/)
  })
  it('undeclared placeholders, unclosed sections, stray braces, bad names', () => {
    expect(() => compile('t', { ...base, text: '{{nope}}' })).toThrow(/undeclared field "nope"/)
    expect(() => compile('t', { ...base, text: '{{#name}} open' })).toThrow(/never closed/)
    expect(() => compile('t', { ...base, text: '{{/name}}' })).toThrow(/unexpected/)
    expect(() => compile('t', { ...base, text: 'a {{ b' })).toThrow(/stray braces/)
    expect(() => compile('t', { ...base, text: '{{a.b}}' })).toThrow(/bad placeholder/)
    expect(() => compile('Bad Name', base)).toThrow(/template name/)
    expect(() => compile('t', { ...base, subject: 'a\nb' })).toThrow(/one line/)
    expect(() => compile('t', { ...base, fields: { u: { type: 'url', default: 'https://x' } } })).toThrow(/bad default/)
    expect(() => compile('t', { ...base, fields: { name: { type: 'html' as never } } })).toThrow(/unknown type/)
  })
  it('an html: false template has no HTML part', () => {
    const t = compile('t', { ...base, html: false })
    expect(render(t, resolveFields(t, { name: 'x' }, LINKS)).html).toBeNull()
  })
})

describe('isEmail', () => {
  it.each([
    ['bob@example.com', true],
    ['bob.smith+tag@mail.example.co.uk', true],
    ['bob@localhost', false],
    ['bob@@example.com', false],
    ['bob..x@example.com', false],
    ['bob@example.com\r\nBcc: x@y.z', false],
    ['"Bob" <bob@example.com>', false],
    ['bob@example.com, eve@example.com', false],
    [`${'a'.repeat(65)}@example.com`, false],
  ])('%s -> %s', (value, ok) => expect(isEmail(value)).toBe(ok))
})
