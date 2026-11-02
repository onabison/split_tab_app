// ocr-receipt: turns an uploaded receipt photo into structured line items.
//
// Called by the app right after a photo is uploaded to the private
// `receipts` bucket. Runs as the calling user (@supabase/server, auth:'user'),
// so the Storage download below is subject to the same trip-membership RLS
// as everything else -- a user can only OCR receipts of trips they belong to.
//
// Request:  POST { path: "<trip_id>/<uuid>.jpg", model?: "claude-haiku-5-5" | "claude-sonnet-5-5" }
// Response: { receipt, problems, usage, model }
//
// Secrets: ANTHROPIC_API_KEY (required), OCR_MODEL (optional default model).
// Ref: https://supabase.com/docs/guides/functions/auth (withSupabase, auth:'user')

import { withSupabase } from 'npm:@supabase/server@1.9.2';
import { Buffer } from 'node:buffer';
import {
  ALLOWED_MODELS,
  DEFAULT_MODEL,
  checkReceipt,
  extractReceipt,
} from '../_shared/receipt-ocr.mjs';

const MAX_BYTES = 7 * 1024 * 1024; // base64 adds ~33%; Claude's limit is 10 MB encoded.
const MEDIA_TYPES: Record<string, string> = {
  'image/jpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp',
};

export default {
  fetch: withSupabase({ auth: 'user' }, async (req, ctx) => {
    if (req.method !== 'POST') {
      return Response.json({ error: 'Use POST' }, { status: 405 });
    }

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      return Response.json({ error: 'ANTHROPIC_API_KEY secret is not set' }, { status: 500 });
    }

    let body: { path?: unknown; model?: unknown };
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: 'Body must be JSON' }, { status: 400 });
    }

    const path = typeof body.path === 'string' ? body.path : '';
    // Same convention the upload and the Storage RLS use: <trip_id>/<file>.
    if (!/^[0-9a-f-]{36}\/[^/]+$/i.test(path)) {
      return Response.json({ error: 'path must look like <trip_id>/<file>' }, { status: 400 });
    }

    const model =
      typeof body.model === 'string' ? body.model : Deno.env.get('OCR_MODEL') ?? DEFAULT_MODEL;
    if (!ALLOWED_MODELS.includes(model)) {
      return Response.json({ error: `model must be one of ${ALLOWED_MODELS.join(', ')}` }, { status: 400 });
    }

    // RLS-scoped download: fails for anyone who isn't a member of that trip.
    const { data: file, error: dlError } = await ctx.supabase.storage.from('receipts').download(path);
    if (dlError || !file) {
      return Response.json({ error: `Could not read receipt: ${dlError?.message ?? 'not found'}` }, { status: 403 });
    }

    const mediaType = MEDIA_TYPES[file.type];
    if (!mediaType) {
      return Response.json({ error: `Unsupported image type "${file.type}" (need JPEG/PNG/WebP)` }, { status: 415 });
    }
    if (file.size > MAX_BYTES) {
      return Response.json({ error: `Image is too large (${file.size} bytes)` }, { status: 413 });
    }

    try {
      const imageBase64 = Buffer.from(await file.arrayBuffer()).toString('base64');
      const result = await extractReceipt({ apiKey, model, imageBase64, mediaType });
      return Response.json({
        receipt: result.receipt,
        problems: checkReceipt(result.receipt),
        usage: result.usage,
        model: result.model,
      });
    } catch (e) {
      console.error('ocr-receipt failed', e);
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
    }
  }),
};
