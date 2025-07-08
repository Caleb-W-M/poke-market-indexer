// scraper.js
import puppeteer from 'puppeteer-core';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';

// ── CONFIG ───────────────────────────────────────────────────────────────
const CARD_NAME  = process.env.CARD_NAME || 'Iono';
const ACCOUNT    = process.env.AZURE_STORAGE_ACCOUNT;
const KEY        = process.env.AZURE_STORAGE_KEY;
const CONTAINER  = 'indexes';
const MAX_POINTS = 500;

// ── Scrape the live “Market Price” from TCGplayer ────────────────────────
async function scrapeMarketPrice(name) {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  const url  = `https://www.tcgplayer.com/search/all/product?q=${encodeURIComponent(name)}`;
  await page.goto(url, { waitUntil: 'networkidle2' });

  // Wait for any pricing labels to appear
  await page.waitForSelector('.pricing__label', { timeout: 10000 });

  // Extract the Market Price by finding the label then its sibling value
  const priceText = await page.evaluate(() => {
    const labels = document.querySelectorAll('.pricing__label');
    for (const label of labels) {
      if (label.textContent.trim() === 'Market Price') {
        const val = label.nextElementSibling;
        return val ? val.textContent.trim() : null;
      }
    }
    return null;
  });

  await browser.close();

  if (!priceText) {
    throw new Error(`Could not find Market Price for "${name}" on page`);
  }
  const m = priceText.match(/[\d,]+\.?\d*/);
  if (!m) {
    throw new Error(`Could not parse price from "${priceText}"`);
  }
  return parseFloat(m[0].replace(/,/g, ''));
}

// ── Append snapshot to Azure Blob (history array) ────────────────────────
async function appendBlob(snapshot) {
  const credential = new StorageSharedKeyCredential(ACCOUNT, KEY);
  const svc        = new BlobServiceClient(
    `https://${ACCOUNT}.blob.core.windows.net`,
    credential
  );
  const containerClient = svc.getContainerClient(CONTAINER);
  await containerClient.createIfNotExists();

  const blobClient = containerClient.getBlobClient(`${CARD_NAME}.json`);
  let history = [];

  try {
    const download = await blobClient.download(0);
    const body     = await streamToString(download.readableStreamBody);
    const data     = JSON.parse(body);
    history = Array.isArray(data) ? data : [data];
  } catch {
    history = [];
  }

  history.push(snapshot);
  if (history.length > MAX_POINTS) {
    history = history.slice(history.length - MAX_POINTS);
  }

  const content = JSON.stringify(history, null, 2);
  await blobClient.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: 'application/json' },
    overwrite: true
  });
}

// ── Helper to read Node streams into a string ────────────────────────────
async function streamToString(readable) {
  let str = '';
  for await (const chunk of readable) {
    str += chunk.toString();
  }
  return str;
}

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  const now   = new Date().toISOString();
  const price = await scrapeMarketPrice(CARD_NAME);
  console.log(`Scraped ${CARD_NAME} @ $${price}`);
  const snapshot = { timestamp: now, card_name: CARD_NAME, price_usd: price };
  await appendBlob(snapshot);
  console.log(`Appended to blob: ${CARD_NAME}.json`, snapshot);
})();
