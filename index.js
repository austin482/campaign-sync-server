require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const LARK_DOMAIN = process.env.LARK_DOMAIN || 'open.larksuite.com';
const BASE_URL = `https://${LARK_DOMAIN}`;

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (allowedOrigins.includes('*') || !origin || allowedOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(new Error('Not allowed by CORS'));
    }
  }
}));
app.use(express.json());

// ─── TOKEN CACHE ──────────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiresAt = 0;

async function getTenantAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60000) return cachedToken;

  const resp = await fetch(`${BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: process.env.LARK_APP_ID,
      app_secret: process.env.LARK_APP_SECRET,
    }),
  });

  const data = await resp.json();
  if (data.code !== 0) throw new Error(`Failed to get Lark token: [${data.code}] ${data.msg}`);

  cachedToken = data.tenant_access_token;
  tokenExpiresAt = now + data.expire * 1000;
  return cachedToken;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function extractSpreadsheetToken(url) {
  const sheetsMatch = url.match(/\/sheets\/([A-Za-z0-9]+)/);
  if (sheetsMatch) return sheetsMatch[1];
  const wikiMatch = url.match(/\/wiki\/([A-Za-z0-9]+)/);
  if (wikiMatch) return wikiMatch[1];
  return null;
}

function extractSheetIdFromUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get('sheet') || null;
  } catch {
    return null;
  }
}

function larkHeaders(token) {
  return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({ status: 'ok', domain: LARK_DOMAIN }));

// ─── GET SHEETS LIST ─────────────────────────────────────────────────────────
app.get('/api/sheets', async (req, res) => {
  try {
    const { spreadsheetUrl } = req.query;
    if (!spreadsheetUrl) return res.status(400).json({ error: 'spreadsheetUrl is required' });

    const spreadsheetToken = extractSpreadsheetToken(spreadsheetUrl);
    if (!spreadsheetToken) return res.status(400).json({ error: 'Could not parse spreadsheet token from URL' });

    const token = await getTenantAccessToken();
    const resp = await fetch(
      `${BASE_URL}/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`,
      { headers: larkHeaders(token) }
    );
    const data = await resp.json();

    if (data.code !== 0) return res.status(500).json({ error: `Lark API error: [${data.code}] ${data.msg}` });

    const sheets = (data.data?.sheets || []).map(s => ({
      sheetId: s.sheet_id,
      title: s.title,
      index: s.index,
    }));

    const preSelectedSheetId = extractSheetIdFromUrl(spreadsheetUrl);
    res.json({ sheets, preSelectedSheetId });
  } catch (err) {
    console.error('[/api/sheets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── READ SHEET DATA ─────────────────────────────────────────────────────────
app.get('/api/sheet', async (req, res) => {
  try {
    const { spreadsheetUrl, sheetId, range } = req.query;
    if (!spreadsheetUrl || !sheetId) {
      return res.status(400).json({ error: 'spreadsheetUrl and sheetId are required' });
    }

    const spreadsheetToken = extractSpreadsheetToken(spreadsheetUrl);
    if (!spreadsheetToken) return res.status(400).json({ error: 'Could not parse spreadsheet token from URL' });

    const cellRange = range || `${sheetId}!A1:Z1000`;
    const token = await getTenantAccessToken();

    const url = `${BASE_URL}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(cellRange)}?valueRenderOption=ToString`;
    const resp = await fetch(url, { headers: larkHeaders(token) });
    const data = await resp.json();

    if (data.code !== 0) return res.status(500).json({ error: `Lark API error: [${data.code}] ${data.msg}` });

    const values = data.data?.valueRange?.values || [];
    res.json({ values, range: cellRange });
  } catch (err) {
    console.error('[/api/sheet]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── WRITE CELL VALUES ───────────────────────────────────────────────────────
app.put('/api/sheet/update', async (req, res) => {
  try {
    const { spreadsheetUrl, updates } = req.body;
    if (!spreadsheetUrl || !updates || !Array.isArray(updates) || updates.length === 0) {
      return res.status(400).json({ error: 'spreadsheetUrl and updates[] are required' });
    }

    const spreadsheetToken = extractSpreadsheetToken(spreadsheetUrl);
    if (!spreadsheetToken) return res.status(400).json({ error: 'Could not parse spreadsheet token from URL' });

    const token = await getTenantAccessToken();
    const valueRanges = updates.map(u => ({ range: u.range, values: [[u.value]] }));

    console.log(`[WRITE] token=${token.slice(-6)} sheet=${spreadsheetToken} ranges=${updates.map(u=>u.range).join(',')}`);

    const resp = await fetch(
      `${BASE_URL}/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values_batch_update`,
      {
        method: 'POST',
        headers: larkHeaders(token),
        body: JSON.stringify({ valueRanges }),
      }
    );
    const data = await resp.json();
    console.log(`[WRITE] Lark response: code=${data.code} msg=${data.msg}`);

    if (data.code !== 0) return res.status(500).json({ error: `Lark API error: [${data.code}] ${data.msg}` });

    res.json({ success: true, updated: updates.length });
  } catch (err) {
    console.error('[/api/sheet/update]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── INSTAGRAM BATCH via APIFY ────────────────────────────────────────────────
// GET /api/instagram/batch?urls[]=URL1&urls[]=URL2
app.get('/api/instagram/batch', async (req, res) => {
  try {
    let urls = req.query.urls || req.query['urls[]'];
    if (!urls) return res.status(400).json({ error: 'urls[] is required' });
    if (!Array.isArray(urls)) urls = [urls];
    urls = urls.filter(Boolean);
    if (urls.length === 0) return res.json({ results: [] });

    const apifyToken = process.env.APIFY_API_TOKEN;
    if (!apifyToken) return res.status(500).json({ error: 'APIFY_API_TOKEN not set' });

    console.log(`[Apify Instagram] Starting run for ${urls.length} URL(s)...`);

    const runResp = await fetch(
      `https://api.apify.com/v2/acts/apify~instagram-scraper/runs?token=${apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          directUrls: urls,
          resultsType: 'posts',
          resultsLimit: 1,
          addParentData: false,
        }),
      }
    );
    const runBody = await runResp.json();
    if (!runBody.data?.id) throw new Error('Failed to start Apify run: ' + JSON.stringify(runBody));

    const runId = runBody.data.id;
    const datasetId = runBody.data.defaultDatasetId;
    console.log(`[Apify Instagram] Run ${runId} started`);

    let succeeded = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const statusResp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
      const statusBody = await statusResp.json();
      const status = statusBody.data?.status;
      console.log(`[Apify Instagram] ${status} (${i * 3}s)`);
      if (status === 'SUCCEEDED') { succeeded = true; break; }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) throw new Error(`Apify run ${status}`);
    }
    if (!succeeded) throw new Error('Apify Instagram run timed out');

    const itemsResp = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&clean=true&limit=200`
    );
    const items = await itemsResp.json();
    console.log(`[Apify Instagram] Got ${items.length} result(s)`);

    const results = urls.map(url => {
      const shortcode = url.match(/\/(p|reel|tv)\/([A-Za-z0-9_-]+)/)?.[2];
      const post = items.find(it =>
        (it.url || it.shortCode || '').includes(shortcode || '__NOMATCH__') ||
        (it.inputUrl || '').includes(url.split('?')[0])
      );
      if (!post) return { url, comments: null, shares: null, likes: null, collects: null };
      return {
        url,
        comments: post.commentsCount ?? post.comments ?? null,
        shares:   null, // Instagram doesn't expose shares publicly
        likes:    post.likesCount ?? post.likes ?? post.videoLikesCount ?? null,
        collects: post.videoViewCount ?? post.videoPlayCount ?? null,
      };
    });

    console.log('[Apify Instagram] Results:', JSON.stringify(results.map(r => ({url: r.url.slice(-30), c: r.comments, l: r.likes}))));
    res.json({ results });
  } catch (err) {
    console.error('[/api/instagram/batch]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── THREADS BATCH via APIFY ──────────────────────────────────────────────────
// GET /api/threads/batch?urls[]=URL1&urls[]=URL2
app.get('/api/threads/batch', async (req, res) => {
  try {
    let urls = req.query.urls || req.query['urls[]'];
    if (!urls) return res.status(400).json({ error: 'urls[] is required' });
    if (!Array.isArray(urls)) urls = [urls];
    urls = urls.filter(Boolean);
    if (urls.length === 0) return res.json({ results: [] });

    const apifyToken = process.env.APIFY_API_TOKEN;
    if (!apifyToken) return res.status(500).json({ error: 'APIFY_API_TOKEN not set' });

    console.log(`[Apify Threads] Starting run for ${urls.length} URL(s)...`);

    const runResp = await fetch(
      `https://api.apify.com/v2/acts/7xFgGDhba8W5ZvOke/runs?token=${apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: urls.map(url => ({ url })),
        }),
      }
    );
    const runBody = await runResp.json();
    if (!runBody.data?.id) throw new Error('Failed to start Apify Threads run: ' + JSON.stringify(runBody));

    const runId = runBody.data.id;
    const datasetId = runBody.data.defaultDatasetId;
    console.log(`[Apify Threads] Run ${runId} started`);

    let succeeded = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const statusResp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
      const statusBody = await statusResp.json();
      const status = statusBody.data?.status;
      console.log(`[Apify Threads] ${status} (${i * 3}s)`);
      if (status === 'SUCCEEDED') { succeeded = true; break; }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) throw new Error(`Apify Threads run ${status}`);
    }
    if (!succeeded) throw new Error('Apify Threads run timed out');

    const itemsResp = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&clean=true&limit=200`
    );
    const items = await itemsResp.json();
    console.log(`[Apify Threads] Got ${items.length} result(s)`);

    const results = urls.map(url => {
      const postId = url.match(/\/post\/([A-Za-z0-9_-]+)/)?.[1];
      const post = items.find(it =>
        (it.url || it.postUrl || it.id || '').includes(postId || '__NOMATCH__') ||
        (it.inputUrl || it.url || '').includes(url.split('?')[0])
      );
      if (!post) return { url, comments: null, shares: null, likes: null, collects: null };
      return {
        url,
        comments: post.repliesCount ?? post.replyCount ?? post.comments ?? null,
        shares:   post.repostCount  ?? post.repostsCount ?? post.shares ?? null,
        likes:    post.likesCount   ?? post.likeCount    ?? post.likes  ?? null,
        collects: post.quotesCount  ?? post.quoteCount   ?? null,
      };
    });

    console.log('[Apify Threads] Results:', JSON.stringify(results.map(r => ({url: r.url.slice(-30), c: r.comments, l: r.likes}))));
    res.json({ results });
  } catch (err) {
    console.error('[/api/threads/batch]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/facebook/batch?urls[]=URL1&urls[]=URL2&...
// Runs ONE Apify actor for ALL Facebook URLs — much faster than one-by-one
app.get('/api/facebook/batch', async (req, res) => {
  try {
    let urls = req.query.urls || req.query['urls[]'];
    if (!urls) return res.status(400).json({ error: 'urls[] is required' });
    if (!Array.isArray(urls)) urls = [urls];
    urls = urls.filter(Boolean);
    if (urls.length === 0) return res.json({ results: [] });

    const apifyToken = process.env.APIFY_API_TOKEN;
    if (!apifyToken) return res.status(500).json({ error: 'APIFY_API_TOKEN not set in .env' });

    console.log(`[Apify Batch] Starting run for ${urls.length} URL(s)...`);

    // Helper: extract post ID from a Facebook URL (numeric OR alphanumeric share IDs)
    function extractFbPostId(url) {
      if (!url) return null;
      const m = url.match(/\/posts\/(\d+)/)         ||
                url.match(/\/permalink\/(\d+)/)      ||  // groups/GROUP_ID/permalink/POST_ID
                url.match(/[?&]story_fbid=(\d+)/)   ||
                url.match(/[?&]fbid=(\d+)/)         ||
                url.match(/\/share\/p\/([A-Za-z0-9]+)/); // share/p/XXXXX short links
      return m ? m[1] : null;
    }

    // ONE Apify run for ALL URLs — maxPosts:1 so we only get the exact post per URL
    const runResp = await fetch(
      `https://api.apify.com/v2/acts/apify~facebook-posts-scraper/runs?token=${apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: urls.map(url => ({ url })),
          maxPosts: 1,           // ← was 3; now only the exact requested post
          maxPostComments: 0,
          proxyConfiguration: { useApifyProxy: true },
        }),
      }
    );
    const runBody = await runResp.json();
    if (!runBody.data?.id) throw new Error('Failed to start Apify run: ' + JSON.stringify(runBody));

    const runId     = runBody.data.id;
    const datasetId = runBody.data.defaultDatasetId;
    console.log(`[Apify Batch] Run ${runId} started`);

    // Poll until finished (max 120 seconds for multiple URLs)
    let succeeded = false;
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const statusResp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
      const statusBody = await statusResp.json();
      const status = statusBody.data?.status;
      console.log(`[Apify Batch] ${status} (${i * 3}s)`);
      if (status === 'SUCCEEDED') { succeeded = true; break; }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) throw new Error(`Apify run ${status}`);
    }
    if (!succeeded) throw new Error('Apify batch run timed out after 120s');

    // Fetch all results
    const itemsResp = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&clean=true&limit=200`
    );
    const items = await itemsResp.json();
    console.log(`[Apify Batch] Got ${items.length} result(s) from dataset`);

    // Map each input URL to its scraped result — match by post ID first, then exact URL
    const results = urls.map(url => {
      const urlBase  = url.split('?')[0].replace(/\/$/, '');
      const inputId  = extractFbPostId(url);

      const post = items.find(it => {
        const itUrl  = (it.facebookUrl || it.url || it.link || '').split('?')[0].replace(/\/$/, '');
        const itId   = extractFbPostId(itUrl) || String(it.legacyId || '') || String(it.postId || '');

        // 1. Match by post ID (most reliable)
        if (inputId && itId && inputId === itId) return true;
        // 2. Exact URL match (ignoring query params + trailing slash)
        if (itUrl === urlBase) return true;
        // 3. Apify sometimes returns a canonical URL — check if it contains our post ID
        if (inputId && itUrl.includes(inputId)) return true;
        return false;
      });

      if (!post || post.error) {
        console.log(`[Apify Batch] No match for ${url.slice(-50)}`);
        return { url, comments: null, shares: null, likes: null, collects: null };
      }
      return {
        url,
        comments: post.commentsCount ?? post.comments ?? null,
        shares:   post.sharesCount   ?? post.shares   ?? null,
        likes:    post.likesCount    ?? post.likes     ?? post.reactionsCount ?? null,
        collects: null,
      };
    });

    res.json({ results });
    console.log('[Apify Batch] Results:', JSON.stringify(results.map(r => ({url: r.url.slice(-40), c: r.comments, s: r.shares, l: r.likes}))));
  } catch (err) {
    console.error('[/api/facebook/batch]', err.message);
    res.status(500).json({ error: err.message });
  }
});


// GET /api/facebook?url=https://www.facebook.com/groups/...
app.get('/api/facebook', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'url is required' });

    const apifyToken = process.env.APIFY_API_TOKEN;
    if (!apifyToken) return res.status(500).json({ error: 'APIFY_API_TOKEN not set in .env' });

    // Step 1: Start Apify facebook-posts-scraper run
    const runResp = await fetch(
      `https://api.apify.com/v2/acts/apify~facebook-posts-scraper/runs?token=${apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: [{ url }],
          maxPosts: 3,
          maxPostComments: 0,
          proxyConfiguration: { useApifyProxy: true },
        }),
      }
    );
    const runBody = await runResp.json();
    if (!runBody.data?.id) throw new Error('Failed to start Apify run: ' + JSON.stringify(runBody));

    const runId     = runBody.data.id;
    const datasetId = runBody.data.defaultDatasetId;
    console.log(`[Apify] Started run ${runId} for: ${url}`);

    // Step 2: Poll until finished (max 90 seconds)
    let succeeded = false;
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const statusResp = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
      const statusBody = await statusResp.json();
      const status = statusBody.data?.status;
      console.log(`[Apify] Run ${runId} → ${status}`);
      if (status === 'SUCCEEDED') { succeeded = true; break; }
      if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) throw new Error(`Apify run ${status}`);
    }
    if (!succeeded) throw new Error('Apify run did not finish in 90 seconds');

    // Step 3: Fetch results from dataset
    const itemsResp = await fetch(
      `https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&clean=true`
    );
    const items = await itemsResp.json();

    if (!items || items.length === 0) {
      return res.json({ comments: null, shares: null, likes: null, collects: null });
    }

    // Pick item matching our URL or fall back to first item
    const post = items.find(it =>
      (it.url || it.link || it.postUrl || '').includes(url.split('?')[0])
    ) || items[0];

    console.log('[Apify] Raw post data:', JSON.stringify(post));

    // Map Apify field names to our metric names
    const comments = post.commentsCount ?? post.comments  ?? null;
    const shares   = post.sharesCount   ?? post.shares    ?? null;
    const likes    = post.likesCount    ?? post.likes     ?? post.reactionsCount ?? post.reactions ?? null;

    res.json({ comments, shares, likes, collects: null });
  } catch (err) {
    console.error('[/api/facebook]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/apify/balance — check remaining Apify credits ──────────────────
app.get('/api/apify/balance', async (req, res) => {
  try {
    const apifyToken = process.env.APIFY_API_TOKEN;
    if (!apifyToken) return res.status(500).json({ error: 'APIFY_API_TOKEN not set' });

    const resp = await fetch(`https://api.apify.com/v2/users/me?token=${apifyToken}`);
    const body = await resp.json();
    const data = body.data || {};
    const plan = data.plan  || {};

    const limitUsd  = plan.monthlyUsageCreditsUsd ?? null; // null = unlimited
    const usedUsd   = data.monthlyUsage?.USD ?? 0;
    const remaining = limitUsd !== null ? Math.max(0, limitUsd - usedUsd) : null;

    res.json({
      used:      parseFloat(usedUsd.toFixed(3)),
      limit:     limitUsd  !== null ? parseFloat(limitUsd.toFixed(2))  : null,
      remaining: remaining !== null ? parseFloat(remaining.toFixed(2)) : null,
      isFree:    !!plan.isFreeAccount,
      planName:  plan.name || 'Free',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Lark Metrics Proxy running on http://localhost:${PORT}`);
  console.log(`   Domain:      ${LARK_DOMAIN}`);
  console.log(`   Lark App ID: ${process.env.LARK_APP_ID ? '✓ set' : '✗ MISSING'}`);
  console.log(`   Apify Token: ${process.env.APIFY_API_TOKEN ? '✓ set' : '— not set (Facebook disabled)'}\n`);
});
