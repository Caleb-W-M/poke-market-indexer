// scraper.js
import puppeteer from 'puppeteer';
import { BlobServiceClient } from '@azure/storage-blob';

// ── CONFIG ────────────────────────────────────────────────────────────
// The exact card name to scrape (must match TCGplayer’s search results)
const CARD_NAME = process.env.CARD_NAME || 'Iono';
// Azure Storage settings from GitHub Secrets / env
const ACCOUNT    = process.env.AZURE_STORAGE_ACCOUNT;
const KEY        = process.env.AZURE_STORAGE_KEY;
const CONTAINER  = 'indexes';
// How many historical points to keep
const MAX_POINTS = 500;
// ───────────────────────────────────────────────────────────────────────

async function scrapeMarketPrice(name) {
  const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
  const page    = await browser.newPage();
  const url     = `https://www.tcgplayer.com/search/all/product?q=${encodeURIComponent(name)}`;

  await page.goto(url, { waitUntil: 'networkidle2' });
  // The “Market Price” element selector
  await page.waitForSelector('.price-point--price', { timeout: 8000 });
  const text = await page.$eval('.price-point--price', el => el.textContent);
  await browser.close();

  const m = text.match(/[\d,]+\.?\d*/);
  if (!m) throw new Error(`Could not parse price from "${text}"`);
  return parseFloat(m[0].replace(/,/g, ''));
}

async function appendBlob(snapshot) {
  const svc   = new BlobServiceClient(
    `https://${ACCOUNT}.blob.core.windows.net`,
    new Azure.SharedKeyCredential(ACCOUNT, KEY)
  );
  const containerClient = svc.getContainerClient(CONTAINER);
  await containerClient.createIfNotExists();

  const blobClient = containerClient.getBlobClient(`${CARD_NAME}.json`);
  let history = [];
  try {
    const dl = await blobClient.download();
    const body = await streamToString(dl.readableStreamBody);
    history = JSON.parse(body);
    if (!Array.isArray(history)) history = [history];
  } catch {
    history = [];
  }

  history.push(snapshot);
  if (history.length > MAX_POINTS) {
    history = history.slice(history.length - MAX_POINTS);
  }

  await blobClient.upload(JSON.stringify(history), Buffer.byteLength(JSON.stringify(history)), {
    blobHTTPHeaders: { blobContentType: 'application/json' },
    overwrite: true
  });
}

// Helper to read Node streams
async function streamToString(readable) {
  let data = '';
  for await (const chunk of readable) data += chunk.toString();
  return data;
}

(async () => {
  const now   = new Date().toISOString();
  const price = await scrapeMarketPrice(CARD_NAME);
  console.log(`Scraped ${CARD_NAME} @ $${price}`);
  await appendBlob({ timestamp: now, card_name: CARD_NAME, price_usd: price });
  console.log(`Appended to blob: ${CARD_NAME}.json`);
})();
