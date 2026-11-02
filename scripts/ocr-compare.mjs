#!/usr/bin/env node
// Runs the receipt-OCR prompt against one or more receipt images with each
// model, so model quality can be compared before choosing one. Uses the
// exact same prompt/schema/checks as the Edge Function
// (supabase/functions/_shared/receipt-ocr.mjs).
//
// Usage (macOS; HEIC photos must be converted first -- Claude doesn't accept HEIC):
//   for f in ~/receipts/*.HEIC; do sips -s format jpeg -Z 2576 "$f" --out "${f%.*}.jpg"; done
//   ANTHROPIC_API_KEY=... node scripts/ocr-compare.mjs ~/receipts/*.jpg
//
// The key is read from the environment only; it is never printed.

import { readFile } from 'node:fs/promises';
import { extname, basename } from 'node:path';
import {
  ALLOWED_MODELS,
  checkReceipt,
  extractReceipt,
} from '../supabase/functions/_shared/receipt-ocr.mjs';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('Set ANTHROPIC_API_KEY in the environment first.');
  process.exit(1);
}
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Pass one or more .jpg/.png receipt images.');
  process.exit(1);
}

const MEDIA = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
// USD per million tokens (input, output), from platform.claude.com pricing, 2026-11-01.
const PRICE = { 'claude-haiku-5-5': [0.1, 0.5], 'claude-sonnet-5-5': [2, 10] };

for (const file of files) {
  const mediaType = MEDIA[extname(file).toLowerCase()];
  if (!mediaType) {
    console.error(`Skipping ${file}: convert it to JPEG first (see usage).`);
    continue;
  }
  const imageBase64 = (await readFile(file)).toString('base64');
  console.log(`\n================ ${basename(file)} ================`);
  for (const model of ALLOWED_MODELS) {
    try {
      const t0 = Date.now();
      const { receipt, usage } = await extractReceipt({ apiKey, model, imageBase64, mediaType });
      const [pin, pout] = PRICE[model];
      const cost = (usage.input_tokens * pin + usage.output_tokens * pout) / 1e6;
      console.log(`\n--- ${model}  (${((Date.now() - t0) / 1000).toFixed(1)}s, ~$${cost.toFixed(4)})`);
      console.log(`merchant: ${receipt.merchant}   date: ${receipt.receipt_date}`);
      for (const i of receipt.items) {
        const mod = i.modifier_of_line != null ? `  (add-on to line ${i.modifier_of_line})` : '';
        const unc = i.uncertain ? '  [uncertain]' : '';
        console.log(`  ${String(i.line).padStart(2)}. ${i.quantity} x ${i.description}  ${i.price.toFixed(2)}${mod}${unc}`);
      }
      const f = (n) => (n == null ? '-' : n.toFixed(2));
      console.log(`subtotal ${f(receipt.subtotal)}  tax ${f(receipt.tax)}  tip ${f(receipt.tip)}  total ${f(receipt.total)}  charged ${f(receipt.amount_charged)}`);
      if (receipt.uncertain_fields.length) console.log(`uncertain: ${receipt.uncertain_fields.join(', ')}`);
      if (receipt.notes) console.log(`notes: ${receipt.notes}`);
      const problems = checkReceipt(receipt);
      console.log(problems.length ? `CHECKS FAILED:\n  - ${problems.join('\n  - ')}` : 'checks: all totals tie');
    } catch (e) {
      console.log(`\n--- ${model}: ERROR ${e.message}`);
    }
  }
}
