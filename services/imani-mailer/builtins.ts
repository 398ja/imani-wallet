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
}
