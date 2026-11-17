/**
 * The templates imani-mailer ships with (#410). Deployments add or replace templates with
 * MAILER_TEMPLATES_FILE (same shape, JSON); a name defined there wins over the one here.
 *
 * Copy rules that apply to every gift email, from #410:
 * - A claim or return link appears in the BODY only, never the subject (url fields cannot be used
 *   in a subject at all: templates.ts refuses it at load).
 * - "Imani never asks for card details or passwords." in every message.
 * - No tracking, no rewritten links: the HTML part's anchors are the checked URLs themselves.
 */
import type { TemplateDef } from './templates.ts'

const FOOTER = 'Imani never asks for card details or passwords. If you did not expect this email, you can ignore it.'

export const BUILTIN_TEMPLATES: Record<string, TemplateDef> = {
  'gift-claim': {
    fromName: 'Imani gifts',
    subject: '{{from}} sent you a voucher for {{stall}}',
    text: [
      '{{from}} sent you a {{amount}} voucher for {{stall}}.',
      '{{#message}}',
      '',
      '{{message}}',
      '{{/message}}',
      '',
      'Claim it by {{claimBy}}:',
      '{{claimUrl}}',
      '',
      'Open the link, create or open an Imani wallet, and tap Claim.',
      "Anyone with this link can claim it. Don't forward it.",
      '',
      FOOTER,
    ].join('\n'),
    fields: {
      from: { type: 'line', max: 80, default: 'Someone' },
      stall: { type: 'line', max: 120, required: true },
      amount: { type: 'line', max: 40, required: true },
      claimBy: { type: 'line', max: 60, required: true },
      claimUrl: { type: 'url', required: true },
      message: { type: 'text', max: 280 },
    },
  },
  'gift-receipt': {
    fromName: 'Imani gifts',
    subject: 'Your {{stall}} voucher gift',
    text: [
      'You paid {{amount}} to {{stall}} for a voucher for {{recipient}}.',
      '',
      'The recipient may need to check their spam folder.',
      "Refunds are the stall's decision.",
      '',
      FOOTER,
    ].join('\n'),
    fields: {
      stall: { type: 'line', max: 120, required: true },
      amount: { type: 'line', max: 40, required: true },
      recipient: { type: 'line', max: 320, required: true },
    },
  },
  'gift-return-link': {
    fromName: 'Imani gifts',
    subject: "If your {{stall}} gift isn't claimed",
    text: [
      "If your gift isn't claimed by {{claimBy}}, use this link to take it back into a wallet:",
      '{{returnUrl}}',
      '{{#spendBy}}',
      '',
      "Once it's back, it keeps its original expiry: {{spendBy}}.",
      '{{/spendBy}}',
      '',
      "Keep it private: it is yours, not the recipient's.",
      '',
      FOOTER,
    ].join('\n'),
    fields: {
      stall: { type: 'line', max: 120, required: true },
      claimBy: { type: 'line', max: 60, required: true },
      returnUrl: { type: 'url', required: true },
      // G17 (C): "spend it by <date>" or "the voucher doesn't expire". Optional for older callers.
      spendBy: { type: 'line', max: 80 },
    },
  },
  'gift-bounced': {
    fromName: 'Imani gifts',
    subject: "We couldn't deliver your gift",
    text: [
      "We couldn't deliver to {{recipient}}.",
      '',
      'The gift is still safe. Take it back with your return link, or from Activity in your wallet.',
      '',
      FOOTER,
    ].join('\n'),
    fields: {
      recipient: { type: 'email', required: true },
    },
  },
  // The recipient's "expires soon" reminder for an unclaimed email gift (#410 §6d). G13: it never
  // carries the claim link (the sealed link secret is deleted once the claim email is accepted, G4),
  // so it has no url field at all and points to the original email by date and subject instead.
  'gift-expiring': {
    fromName: 'Imani gifts',
    subject: 'Your voucher for {{stall}} expires soon',
    text: [
      '{{from}} sent you a {{amount}} voucher for {{stall}}, and it has not been claimed yet.',
      '',
      'Claim it by {{claimBy}}, or it goes back to {{from}}.',
      '',
      'To claim it, open the link in our email of {{sentOn}} from {{sender}}, with the subject:',
      '"{{claimSubject}}"',
      'If you cannot find it, check your spam or junk folder.',
      '',
      "If you've already claimed it, you can ignore this email.",
      '',
      FOOTER,
    ].join('\n'),
    fields: {
      from: { type: 'line', max: 80, default: 'Someone' },
      stall: { type: 'line', max: 120, required: true },
      amount: { type: 'line', max: 40, required: true },
      claimBy: { type: 'line', max: 60, required: true },
      sentOn: { type: 'line', max: 60, required: true },
      sender: { type: 'line', max: 254, required: true },
      claimSubject: { type: 'line', max: 250, required: true },
    },
  },
  // G15 §4.3: the buyer's notices from purchase-issuer. No url field in either: no link, no key.
  'gift-claimed': {
    fromName: 'Imani gifts',
    subject: 'Your {{stall}} gift was claimed',
    text: ['{{recipient}} claimed the {{amount}} voucher for {{stall}} you sent.', '', FOOTER].join('\n'),
    fields: {
      stall: { type: 'line', max: 120, required: true },
      amount: { type: 'line', max: 40, required: true },
      recipient: { type: 'line', max: 320, required: true },
    },
  },
  'gift-expired': {
    fromName: 'Imani gifts',
    subject: "Your {{stall}} gift wasn't claimed",
    text: [
      "Your {{amount}} voucher for {{stall}} to {{recipient}} wasn't claimed by {{claimBy}}.",
      '',
      '{{howBack}}',
      '{{#spendBy}}',
      '{{spendBy}}',
      '{{/spendBy}}',
      '',
      FOOTER,
    ].join('\n'),
    fields: {
      stall: { type: 'line', max: 120, required: true },
      amount: { type: 'line', max: 40, required: true },
      recipient: { type: 'line', max: 320, required: true },
      claimBy: { type: 'line', max: 60, required: true },
      howBack: { type: 'text', max: 400, required: true },
      // G17: the expiry a taken-back voucher keeps. Optional: absent on gifts tracked before it.
      spendBy: { type: 'line', max: 120 },
    },
  },
  'gift-reminder': {
    fromName: 'Imani gifts',
    subject: 'Your {{stall}} gift: {{when}}',
    text: ['A reminder about your {{stall}} gift: {{when}}.', '{{returnUrl}}', '', FOOTER].join('\n'),
    fields: {
      stall: { type: 'line', max: 120, required: true },
      when: { type: 'line', max: 60, required: true },
      returnUrl: { type: 'url', required: true },
    },
  },
  // #410 code gifts (owner, 2026-11-05). A code is a bearer instrument: never "take it back". What is
  // left at expiry comes back to the buyer's return link. The code itself appears in the BODY only.
  'gift-code': {
    fromName: 'Imani gifts',
    subject: '{{from}} sent you a {{stall}} shop code',
    text: [
      '{{from}} sent you a {{amount}} code to spend at {{shop}}.',
      '{{#message}}',
      '',
      '{{message}}',
      '{{/message}}',
      '',
      'Your code:',
      '{{code}}',
      '',
      'Enter it at checkout on {{shopUrl}}',
      'Use it by {{expiresOn}}. You can spend it over several orders: whatever you leave stays on the code until then.',
      '',
      'Check what is left on it:',
      '{{balanceUrl}}',
      '',
      "Anyone with this code can spend it. Don't forward it.",
      '',
      FOOTER,
    ].join('\n'),
    fields: {
      from: { type: 'line', max: 80, default: 'Someone' },
      stall: { type: 'line', max: 120, required: true },
      shop: { type: 'line', max: 253, required: true },
      amount: { type: 'line', max: 40, required: true },
      code: { type: 'line', max: 24, required: true },
      // A LINE, not a url: every shop has its own host, so MAILER_LINK_HOSTS cannot list them, and a
      // url field would refuse every code gift. payment-adapter pins it from the stall's SIGNED
      // `imani:merchant` record (https only, fail closed) and purchase-issuer re-checks it is https.
      // The balance link below points at our own code store, so it stays an allow-listed url.
      shopUrl: { type: 'line', max: 300, required: true },
      expiresOn: { type: 'line', max: 60, required: true },
      balanceUrl: { type: 'url', required: true },
      message: { type: 'text', max: 280 },
    },
  },
  'gift-code-return-link': {
    fromName: 'Imani gifts',
    subject: 'Your {{stall}} shop code gift',
    text: [
      "The code can't be taken back. Whatever isn't spent by {{expiresOn}} comes back to you.",
      'After then, open this link to receive it in a wallet:',
      '{{returnUrl}}',
      '',
      "Keep it private: it is yours, not the recipient's.",
      '',
      FOOTER,
    ].join('\n'),
    fields: {
      stall: { type: 'line', max: 120, required: true },
      expiresOn: { type: 'line', max: 60, required: true },
      returnUrl: { type: 'url', required: true },
    },
  },
  // The buyer's notices for a code gift. No url field: no link, no key, no code.
  'gift-code-used': {
    fromName: 'Imani gifts',
    subject: 'Your {{stall}} shop code was used',
    text: [
      '{{recipient}} used {{spent}} of the {{amount}} code for {{stall}} you sent.',
      '{{#remaining}}',
      '{{remaining}} is left on the code, to spend until {{expiresOn}}.',
      '{{/remaining}}',
      '',
      FOOTER,
    ].join('\n'),
    fields: {
      stall: { type: 'line', max: 120, required: true },
      amount: { type: 'line', max: 40, required: true },
      spent: { type: 'line', max: 40, required: true },
      recipient: { type: 'line', max: 320, required: true },
      expiresOn: { type: 'line', max: 60, required: true },
      remaining: { type: 'line', max: 40 },
    },
  },
  'gift-code-expired': {
    fromName: 'Imani gifts',
    subject: 'Your {{stall}} shop code has expired',
    text: [
      'The {{amount}} code for {{stall}} you sent to {{recipient}} expired on {{expiresOn}}.',
      '{{remaining}} was left on it, and it comes back to you.',
      'Open the return link from our email of {{returnMailDate}} to receive it in a wallet.',
      '',
      FOOTER,
    ].join('\n'),
    fields: {
      stall: { type: 'line', max: 120, required: true },
      amount: { type: 'line', max: 40, required: true },
      recipient: { type: 'line', max: 320, required: true },
      expiresOn: { type: 'line', max: 60, required: true },
      remaining: { type: 'line', max: 40, required: true },
      returnMailDate: { type: 'line', max: 60, required: true },
    },
  },
  // The recipient's "expires soon" reminder for an unspent shop code (#410 §6d applied to codes).
  // Like gift-expiring it carries no secret: not the code (a bearer secret), not a link. It names
  // the original email by date and subject.
  'gift-code-expiring': {
    fromName: 'Imani gifts',
    subject: 'Your {{stall}} shop code expires soon',
    text: [
      '{{from}} sent you a {{amount}} code to spend at {{stall}}, and it has not been used yet.',
      '',
      'Use it by {{claimBy}}, or what is left ({{remaining}}) goes back to {{from}}.',
      '',
      'The code is in our email of {{sentOn}} from {{sender}}, with the subject:',
      '"{{claimSubject}}"',
      'If you cannot find it, check your spam or junk folder.',
      '',
      "If you've already used it, you can ignore this email.",
      '',
      FOOTER,
    ].join('\n'),
    fields: {
      from: { type: 'line', max: 80, default: 'Someone' },
      stall: { type: 'line', max: 120, required: true },
      amount: { type: 'line', max: 40, required: true },
      remaining: { type: 'line', max: 40, required: true },
      claimBy: { type: 'line', max: 60, required: true },
      sentOn: { type: 'line', max: 60, required: true },
      sender: { type: 'line', max: 254, required: true },
      claimSubject: { type: 'line', max: 250, required: true },
    },
  },
}
