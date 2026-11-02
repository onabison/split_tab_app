// Shared receipt-OCR logic: the Claude request, the output schema, and the
// math checks. Plain JavaScript (ES module) on purpose, so the same file is
// imported by the Supabase Edge Function (Deno) and by
// scripts/ocr-compare.mjs (Node) -- one prompt, one schema, two callers.
//
// API references (checked 2026-11-01):
// - Structured outputs: output_config.format, type "json_schema"; every
//   object needs additionalProperties:false; no minimum/maximum.
//   https://platform.claude.com/docs/en/build-with-claude/structured-outputs
// - Images: JPEG/PNG/GIF/WebP only (no HEIC), max 10 MB base64.
//   https://platform.claude.com/docs/en/build-with-claude/vision

// Sonnet chosen 2026-11-01 after comparing on 3 real receipts: Haiku failed
// the crumpled one (price column skewed); Sonnet matched every confirmed value.
export const DEFAULT_MODEL = 'claude-sonnet-5-5';
export const ALLOWED_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];

const nullableNumber = { type: ['number', 'null'] };
const nullableString = { type: ['string', 'null'] };

export const RECEIPT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'merchant',
    'receipt_date',
    'items',
    'subtotal',
    'tax',
    'tip',
    'total',
    'amount_charged',
    'uncertain_fields',
    'notes',
  ],
  properties: {
    merchant: { ...nullableString, description: 'Business name as printed.' },
    receipt_date: {
      ...nullableString,
      description: 'Date (and time if printed) of the purchase, ISO 8601 if possible.',
    },
    items: {
      type: 'array',
      description: 'Every purchasable line, in the order printed on the receipt.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['line', 'description', 'quantity', 'price', 'modifier_of_line', 'uncertain'],
        properties: {
          line: { type: 'integer', description: '1-based position in the printed list.' },
          description: { type: 'string' },
          quantity: { type: 'number' },
          price: {
            type: 'number',
            description: 'Line total as printed (already multiplied by quantity).',
          },
          modifier_of_line: {
            type: ['integer', 'null'],
            description:
              'If this line is an add-on/modifier of another line (e.g. "Add Cheddar" under a burger), that line number; otherwise null.',
          },
          uncertain: {
            type: 'boolean',
            description: 'True if the description or price was hard to read or inferred.',
          },
        },
      },
    },
    subtotal: nullableNumber,
    tax: nullableNumber,
    tip: { ...nullableNumber, description: 'Only if a tip amount is actually written/printed.' },
    total: { ...nullableNumber, description: 'Printed bill total (before any tip line).' },
    amount_charged: {
      ...nullableNumber,
      description:
        'If the receipt shows this card/payment covered only part of the bill (split check), the amount charged to it; otherwise null.',
    },
    uncertain_fields: {
      type: 'array',
      items: { type: 'string' },
      description: 'Names of top-level fields you are unsure about.',
    },
    notes: { ...nullableString, description: 'Anything a person should double-check.' },
  },
};

export const RECEIPT_PROMPT = `Extract this receipt into the JSON schema.

Rules:
- List every purchasable line in printed order. Keep add-ons/modifiers (e.g. "BC OLIVES", "Add Cheddar") as their own lines and set modifier_of_line to the line they belong to.
- Prices: thermal receipts are often crumpled or skewed, so the price column can drift up or down relative to the item names. Match prices to items by ORDER (the Nth price belongs to the Nth line), not by which row they visually sit on. Check that the item prices add up to the printed subtotal; if they don't, re-check the matching and mark the lines you're unsure about.
- price is the line total as printed. quantity is the printed quantity (default 1).
- If a name is partly faded, infer it from the visible letters and set uncertain=true.
- If the receipt has no itemized lines (e.g. a parking ticket showing only an amount paid), return ONE item describing what was paid for (e.g. "Parking") with that amount.
- tip: only a tip amount that is actually written or printed; null if the tip line is blank.
- amount_charged: if the receipt shows a partial/split payment (e.g. "Previous Payment Total" or an Amount lower than the bill total), the amount charged on this receipt; otherwise null.
- Never include card numbers, approval codes or other payment identifiers anywhere.
- Use null for anything not on the receipt. Do not guess totals.`;

/** Build the Messages API request body. */
export function buildRequest({ model, imageBase64, mediaType }) {
  if (!ALLOWED_MODELS.includes(model)) throw new Error(`Model not allowed: ${model}`);
  return {
    model,
    max_tokens: 8192, // long receipts; billed only for tokens actually used
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: RECEIPT_PROMPT },
        ],
      },
    ],
    output_config: { format: { type: 'json_schema', schema: RECEIPT_SCHEMA } },
  };
}

/** Call the Claude API. Returns { receipt, usage, model, stop_reason }. */
export async function extractReceipt({ apiKey, model = DEFAULT_MODEL, imageBase64, mediaType }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(buildRequest({ model, imageBase64, mediaType })),
  });
  const body = await res.json();
  if (!res.ok) {
    const msg = body?.error?.message ?? JSON.stringify(body);
    throw new Error(`Claude API ${res.status}: ${msg}`);
  }
  if (body.stop_reason !== 'end_turn') {
    throw new Error(`Claude stopped early (${body.stop_reason}); output may be incomplete.`);
  }
  const text = body.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Claude returned no text block.');
  return { receipt: JSON.parse(text), usage: body.usage, model: body.model, stop_reason: body.stop_reason };
}

const cents = (n) => Math.round(n * 100);

/**
 * Math checks (Stage 3i, highest-confidence signal). Returns a list of
 * human-readable problems; empty list = everything that can be checked ties.
 */
export function checkReceipt(r) {
  const problems = [];
  const itemSum = r.items.reduce((s, i) => s + cents(i.price), 0);
  if (r.subtotal != null && itemSum !== cents(r.subtotal)) {
    problems.push(`Items add up to ${(itemSum / 100).toFixed(2)} but subtotal is ${r.subtotal.toFixed(2)}`);
  }
  if (r.subtotal != null && r.total != null) {
    const expected = cents(r.subtotal) + cents(r.tax ?? 0);
    if (expected !== cents(r.total)) {
      problems.push(
        `Subtotal ${r.subtotal.toFixed(2)} + tax ${(r.tax ?? 0).toFixed(2)} = ${(expected / 100).toFixed(2)}, but total is ${r.total.toFixed(2)}`
      );
    }
  }
  if (r.subtotal == null && r.total != null && r.tax == null && itemSum !== cents(r.total)) {
    problems.push(`Items add up to ${(itemSum / 100).toFixed(2)} but total is ${r.total.toFixed(2)}`);
  }
  for (const i of r.items) {
    if (i.modifier_of_line != null && !r.items.some((p) => p.line === i.modifier_of_line)) {
      problems.push(`Line ${i.line} is marked as a modifier of line ${i.modifier_of_line}, which doesn't exist`);
    }
  }
  return problems;
}
