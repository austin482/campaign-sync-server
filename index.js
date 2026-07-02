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

// ─── APIFY TOKEN POOL ─────────────────────────────────────────────────────────
// Support multiple tokens via APIFY_API_TOKENS=token1,token2,token3
// Falls back to APIFY_API_TOKEN for backward compatibility
const apifyTokenPool = (process.env.APIFY_API_TOKENS || process.env.APIFY_API_TOKEN || '')
  .split(',').map(t => t.trim()).filter(Boolean);
let apifyTokenIndex = 0;

function getApifyToken() {
  return apifyTokenPool[apifyTokenIndex] || null;
}

function switchToNextApifyToken() {
  if (apifyTokenPool.length <= 1) return false;
  const prev = apifyTokenIndex;
  apifyTokenIndex = (apifyTokenIndex + 1) % apifyTokenPool.length;
  console.log(`[Apify] ⚠️ Token #${prev + 1} exhausted → switching to token #${apifyTokenIndex + 1} of ${apifyTokenPool.length}`);
  return true;
}

function isApifyQuotaError(body) {
  // Detect billing/quota errors from Apify API response
  const msg = JSON.stringify(body || '').toLowerCase();
  return msg.includes('payment') || msg.includes('insufficient') ||
         msg.includes('credit') || msg.includes('limit exceeded') ||
         msg.includes('quota') || msg.includes('402');
}

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

    let apifyToken = getApifyToken();
    if (!apifyToken) return res.status(500).json({ error: 'No Apify token configured' });

    console.log(`[Apify Instagram] Starting run for ${urls.length} URL(s)... (token #${apifyTokenIndex + 1}/${apifyTokenPool.length})`);

    let runBody;
    for (let attempt = 0; attempt < apifyTokenPool.length; attempt++) {
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
      runBody = await runResp.json();
      if (runResp.status === 402 || isApifyQuotaError(runBody)) {
        if (!switchToNextApifyToken()) throw new Error('All Apify tokens exhausted');
        apifyToken = getApifyToken();
        continue;
      }
      break;
    }
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

    let apifyToken = getApifyToken();
    if (!apifyToken) return res.status(500).json({ error: 'No Apify token configured' });

    console.log(`[Apify Threads] Starting run for ${urls.length} URL(s)... (token #${apifyTokenIndex + 1}/${apifyTokenPool.length})`);

    let runBody;
    for (let attempt = 0; attempt < apifyTokenPool.length; attempt++) {
      const runResp = await fetch(
        `https://api.apify.com/v2/acts/7xFgGDhba8W5ZvOke/runs?token=${apifyToken}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ urls: urls.map(url => ({ url })) }),
        }
      );
      runBody = await runResp.json();
      if (runResp.status === 402 || isApifyQuotaError(runBody)) {
        if (!switchToNextApifyToken()) throw new Error('All Apify tokens exhausted');
        apifyToken = getApifyToken();
        continue;
      }
      break;
    }
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

    let apifyToken = getApifyToken();
    if (!apifyToken) return res.status(500).json({ error: 'No Apify token configured' });

    console.log(`[Apify Batch] Starting run for ${urls.length} URL(s)... (token #${apifyTokenIndex + 1}/${apifyTokenPool.length})`);

    // Helper: extract post ID from a Facebook URL (numeric OR alphanumeric share IDs)
    function extractFbPostId(url) {
      if (!url) return null;
      const m = url.match(/\/posts\/(\d+)/)            ||
                url.match(/\/permalink\/(\d+)/)         ||  // groups/GROUP_ID/permalink/POST_ID
                url.match(/[?&]story_fbid=(\d+)/)      ||
                url.match(/[?&]fbid=(\d+)/)            ||
                url.match(/\/reel\/(\d+)/)             ||  // Facebook Reels
                url.match(/\/videos\/(\d+)/)           ||  // Facebook Videos
                url.match(/\/share\/r\/([A-Za-z0-9]+)/) || // shared reels short links
                url.match(/\/share\/p\/([A-Za-z0-9]+)/);  // shared post short links
      return m ? m[1] : null;
    }

    // Normalize + resolve Facebook URLs before sending to Apify
    async function normalizeFbUrl(url) {
      // 1. Ensure https://www. prefix
      if (url.startsWith('facebook.com')) url = 'https://www.' + url;
      if (url.startsWith('www.facebook.com')) url = 'https://' + url;

      // 2. Convert /reel/ID → /watch/?v=ID (Apify handles this better)
      const reelMatch = url.match(/facebook\.com\/reel\/(\d+)/);
      if (reelMatch) {
        url = `https://www.facebook.com/watch/?v=${reelMatch[1]}`;
        console.log(`[URL Normalize] Reel → watch: ${url}`);
        return url;
      }

      // 3. Resolve share/p/, share/r/, share/v/ short links via redirect
      if (/\/share\/(p|r|v)\//.test(url)) {
        try {
          const resp = await fetch(url, {
            method: 'GET',
            redirect: 'manual',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
          });
          const loc = resp.headers.get('location');
          if (loc && loc.includes('facebook.com')) {
            const resolved = loc.split('?')[0];
            console.log(`[URL Resolve] ${url.slice(-40)} → ${resolved.slice(-60)}`);
            return resolved;
          }
        } catch (e) { console.log(`[URL Resolve] Failed: ${e.message}`); }
      }

      return url;
    }

    const resolvedUrls = await Promise.all(urls.map(normalizeFbUrl));
    console.log('[Apify Batch] Resolved URLs:', resolvedUrls.map(u => u.slice(-60)));

    // ONE Apify run for ALL URLs
    let runBody;
    for (let attempt = 0; attempt < apifyTokenPool.length; attempt++) {
    const runResp = await fetch(
      `https://api.apify.com/v2/acts/apify~facebook-posts-scraper/runs?token=${apifyToken}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startUrls: resolvedUrls.map(url => ({ url })),
          maxPosts: 1,
          maxPostComments: 0,
          proxyConfiguration: { useApifyProxy: true },
        }),
      }
    );
      runBody = await runResp.json();
      if (runResp.status === 402 || isApifyQuotaError(runBody)) {
        if (!switchToNextApifyToken()) throw new Error('All Apify tokens exhausted');
        apifyToken = getApifyToken();
        continue;
      }
      break;
    }
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
    const results = urls.map((url, urlIdx) => {
      const urlBase     = url.split('?')[0].replace(/\/$/, '');
      const inputId     = extractFbPostId(url);
      const isShareLink = /\/share\/(p|r|v)\//.test(url);

      const post = items.find(it => {
        const itUrl      = (it.facebookUrl || it.url || it.link || '').split('?')[0].replace(/\/$/, '');
        const itInputUrl = (it.inputUrl || '').split('?')[0].replace(/\/$/, '');
        const itId       = extractFbPostId(itUrl) || String(it.legacyId || '') || String(it.postId || '');

        // 1. Match by post ID
        if (inputId && itId && inputId === itId) return true;
        // 2. Exact URL match
        if (itUrl === urlBase) return true;
        // 3. Match via Apify's inputUrl (best for share/p/ redirects)
        if (itInputUrl && itInputUrl === urlBase) return true;
        if (itInputUrl && inputId && itInputUrl.includes(inputId)) return true;
        // 4. Canonical URL contains share code
        if (inputId && itUrl.includes(inputId)) return true;
        return false;
      // 5. Fallback: if all URLs are share links and item count matches, match by position
      }) || (isShareLink && items.length === urls.length ? items[urlIdx] : null);

      if (!post || post.error) {
        console.log(`[Apify Batch] No match for ${url.slice(-50)}`);
        return { url, comments: null, shares: null, likes: null, collects: null };
      }

      return {
        url,
        comments: post.commentsCount  ?? post.comments        ?? post.commentCount ?? null,
        shares:   post.sharesCount    ?? post.shares           ?? post.shareCount   ??
                  post.videoShareCount ?? post.reshareCount    ?? null,
        likes:    post.likesCount     ?? post.likes            ?? post.likeCount    ??
                  post.reactionsCount ?? post.reactionCount    ??
                  post.videoLikeCount ?? null,
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

    let apifyToken = getApifyToken();
    if (!apifyToken) return res.status(500).json({ error: 'No Apify token configured' });

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

// ─── GET /api/facebook/debug — raw Apify output for one URL ──────────────────
app.get('/api/facebook/debug', async (req, res) => {
  try {
    let url = req.query.url;
    if (!url) return res.status(400).json({ error: 'url param required' });
    if (url.startsWith('facebook.com')) url = 'https://www.' + url;
    if (url.startsWith('www.facebook.com')) url = 'https://' + url;

    const reelMatch = url.match(/facebook\.com\/reel\/(\d+)/);
    if (reelMatch) url = `https://www.facebook.com/watch/?v=${reelMatch[1]}`;

    const apifyToken = getApifyToken();
    const runResp = await fetch(
      `https://api.apify.com/v2/acts/apify~facebook-posts-scraper/runs?token=${apifyToken}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ startUrls: [{ url }], maxPosts: 1, maxPostComments: 0, proxyConfiguration: { useApifyProxy: true } }) }
    );
    const runBody = await runResp.json();
    if (!runBody.data?.id) return res.json({ error: 'Run failed', runBody });

    const runId = runBody.data.id;
    const datasetId = runBody.data.defaultDatasetId;
    let status = 'RUNNING';
    for (let i = 0; i < 40 && !['SUCCEEDED','FAILED','ABORTED'].includes(status); i++) {
      await new Promise(r => setTimeout(r, 3000));
      const s = await fetch(`https://api.apify.com/v2/actor-runs/${runId}?token=${apifyToken}`);
      status = (await s.json()).data?.status;
    }
    const items = await (await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${apifyToken}&clean=true`)).json();
    res.json({ resolvedUrl: url, status, itemCount: items.length, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── GET /api/apify/balance — check remaining Apify credits ──────────────────
app.get('/api/apify/balance', async (req, res) => {
  try {
    if (apifyTokenPool.length === 0) return res.status(500).json({ error: 'No Apify token configured' });

    // Fetch balance for ALL tokens in the pool
    const balances = await Promise.all(apifyTokenPool.map(async (token, idx) => {
      try {
        const resp = await fetch(`https://api.apify.com/v2/users/me?token=${token}`);
        const body = await resp.json();
        const data = body.data || {};
        const plan = data.plan || {};
        const limitUsd  = plan.monthlyUsageCreditsUsd ?? null;
        const usedUsd   = data.monthlyUsage?.USD ?? 0;
        const remaining = limitUsd !== null ? Math.max(0, limitUsd - usedUsd) : null;
        return {
          tokenIndex: idx + 1,
          active:     idx === apifyTokenIndex,
          used:       parseFloat(usedUsd.toFixed(3)),
          limit:      limitUsd !== null ? parseFloat(limitUsd.toFixed(2)) : null,
          remaining:  remaining !== null ? parseFloat(remaining.toFixed(2)) : null,
          isFree:     !!plan.isFreeAccount,
          planName:   plan.name || 'Free',
        };
      } catch {
        return { tokenIndex: idx + 1, active: idx === apifyTokenIndex, error: 'Failed to fetch' };
      }
    }));

    // For backward compat: also return top-level fields based on active token
    const active = balances[apifyTokenIndex] || balances[0];
    res.json({
      ...active,
      totalTokens: apifyTokenPool.length,
      tokens: balances,
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
  console.log(`   Apify Tokens: ${apifyTokenPool.length} configured (active: #${apifyTokenIndex + 1})\n`);

  // ── Keep-alive ping (Render free tier spins down after 15 min idle) ──────────
  // Self-ping every 13 minutes so the server stays warm during sync sessions.
  const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
  if (PUBLIC_URL) {
    setInterval(() => {
      fetch(`${PUBLIC_URL}/api/health`)
        .then(() => console.log('[KeepAlive] ping ok'))
        .catch(e => console.warn('[KeepAlive] ping failed:', e.message));
    }, 13 * 60 * 1000); // every 13 minutes
    console.log(`   Keep-alive: pinging ${PUBLIC_URL}/api/health every 13 min`);
  }
});
