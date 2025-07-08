// scraper.js
import puppeteer from 'puppeteer-core';
import { BlobServiceClient, StorageSharedKeyCredential } from '@azure/storage-blob';

// ── CONFIG ───────────────────────────────────────────────────────────────
const CARD_NAME  = process.env.CARD_NAME || 'Iono';
const ACCOUNT    = process.env.AZURE_STORAGE_ACCOUNT;
const KEY        = process.env.AZURE_STORAGE_KEY;
const CONTAINER  = 'indexes';
const MAX_POINTS = 500;
// ────────────────────────────────────────────────────────────────────────

// Scrape the live “Market Price” from TCGplayer using XPath
async function scrapeMarketPrice(name) {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome-stable',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  const url  = `https://www.tcgplayer.com/search/all/product?q=${encodeURIComponent(name)}`;
  await page.goto(url, { waitUntil: 'networkidle2' });

  // Wait up to 20s for any label containing “Market Price”
  const [labelElem] = await page.$x(
    "//span[contains(text(),'Market Price') or contains(text(),'market price')]/ancestor::div[contains(@class,'pricing')]"
  );
  if (!labelElem) {
    await browser.close();
    throw new Error(`“Market Price” label not found for "${name}"`);
  }

  // Within that pricing container, find the price value element
  const valueElem = await labelElem.$('span[class*="amount"], div[class*="value"], .price'); 
  if (!valueElem) {
    await browser.close();
    throw new Error(`Price element not found next to label for "${name}"`);
  }

  let text = await page.evaluate(el => el.textContent.trim(), valueElem);
  await browser.close();

  const m = text.match(/[\d,]+\.?\d*/);
  if (!m) throw new Error(`Could not parse price from "${text}"`);
  return parseFloat(m[0].replace(/,/g, ''));
}

// Append snapshot to Azure Blob
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
    const dl   = await blobClient.download(0);
    const body = await streamToString(dl.readableStreamBody);
    const data = JSON.parse(body);
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

// Helper to read Node streams into a string
async function streamToString(readable) {
  let str = '';
  for await (const chunk of readable) str += chunk.toString();
  return str;
}

// Main
(async () => {
  const now   = new Date().toISOString();
  const price = await scrapeMarketPrice(CARD_NAME);
  console.log(`Scraped ${CARD_NAME} @ $${price}`);
  const snapshot = { timestamp: now, card_name: CARD_NAME, price_usd: price };
  await appendBlob(snapshot);
  console.log(`Appended to blob: ${CARD_NAME}.json`, snapshot);
})();
