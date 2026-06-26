// Apify SDK - toolkit for building Apify Actors (https://docs.apify.com/sdk/js/).
import { Actor, log } from 'apify';
// Axios - Promise based HTTP client for node.js (https://axios-http.com/docs/intro).
import axios from 'axios';
// Agent for routing axios requests through an HTTP(S) proxy.
import { HttpsProxyAgent } from 'https-proxy-agent';

// Network-free parsing helpers (unit-tested in test/scrape.test.ts).
import {
    extractOgImage,
    extractPdpName,
    extractPdpPrice,
    extractPreview,
    hostnameOf,
    isDarazProductUrl,
    isProductImage,
    looksBlocked,
} from './scrape.js';

await Actor.init();

/** Shape of the Actor input, defined in .actor/input_schema.json */
interface Input {
    profileUrl: string;
    linkFilter?: string;
    expandShortLinks?: boolean;
    scrapeProductDetails?: boolean;
    maxConcurrency?: number;
    proxyConfiguration?: {
        useApifyProxy?: boolean;
        apifyProxyGroups?: string[];
        proxyUrls?: string[];
    };
}

/** One raw link as it appears inside Linktree's embedded __NEXT_DATA__ JSON. */
interface LinktreeLink {
    id: number;
    type: string;
    title: string;
    url: string;
    position: number;
    parent?: { id: number } | null;
}

/** Product details scraped from a Daraz product page. */
interface ProductDetails {
    productName: string | null;
    price: string | null;
    originalPrice: string | null;
    discount: string | null;
    images: string[];
    resolvedUrl: string | null;
    detailStatus: string;
}

/** One row we push to the dataset. */
interface OutputLink extends Partial<ProductDetails> {
    profileUsername: string;
    title: string;
    url: string;
    expandedUrl: string | null;
    domain: string;
    type: string;
    group: string;
    position: number;
    scrapedAt: string;
}

const input = await Actor.getInput<Input>();
if (!input) throw new Error('Input is missing!');

const {
    profileUrl,
    linkFilter = '',
    expandShortLinks = false,
    scrapeProductDetails = true,
    maxConcurrency = 5,
    proxyConfiguration: proxyInput,
} = input;

if (!profileUrl || !/^https?:\/\/(www\.)?linktr\.ee\/.+/i.test(profileUrl.trim())) {
    throw new Error(
        `"profileUrl" must be a valid Linktree URL like https://linktr.ee/username. Received: ${profileUrl}`,
    );
}

const cleanUrl = profileUrl.trim().split('?')[0].replace(/\/+$/, '');
const filterTerm = linkFilter.trim().toLowerCase();
// Scraping product details requires resolving the short link to the real product URL.
const needsExpansion = expandShortLinks || scrapeProductDetails;

// Configure proxy (recommended on the Apify platform, ideally Nepal residential for Daraz).
const proxyConfiguration = await Actor.createProxyConfiguration(proxyInput);

const BROWSER_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

/** Build an https-proxy-agent config object for axios from a proxy URL. */
function buildProxyAgent(proxyUrl: string) {
    const agent = new HttpsProxyAgent(proxyUrl);
    return { httpAgent: agent, httpsAgent: agent };
}

/** A single GET that returns status + body and never throws. Routes via proxy if set. */
async function getPage(
    url: string,
    opts: { maxRedirects?: number; timeout?: number } = {},
): Promise<{ status: number; data: string; finalUrl: string }> {
    const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
    try {
        const res = await axios.get<string>(url, {
            headers: BROWSER_HEADERS,
            timeout: opts.timeout ?? 30_000,
            maxRedirects: opts.maxRedirects ?? 5,
            responseType: 'text',
            validateStatus: () => true,
            ...(proxyUrl ? { proxy: false as const, ...buildProxyAgent(proxyUrl) } : {}),
        });
        return {
            status: res.status,
            data: typeof res.data === 'string' ? res.data : '',
            finalUrl: res.request?.res?.responseUrl ?? url,
        };
    } catch (err) {
        log.debug(`GET failed for ${url}: ${(err as Error).message}`);
        return { status: 0, data: '', finalUrl: url };
    }
}

/** Fetch the profile HTML, retrying with backoff. Throws if it can't. */
async function fetchProfileHtml(url: string): Promise<string> {
    const maxAttempts = 4;
    let lastStatus = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const { status, data } = await getPage(url);
        if (status >= 200 && status < 300 && data) return data;
        lastStatus = status;
        log.warning(`Profile fetch attempt ${attempt}/${maxAttempts} got status ${status}.`);
        if (attempt < maxAttempts) {
            await new Promise((r) => {
                setTimeout(r, attempt * 2_000);
            });
        }
    }
    throw new Error(`Failed to fetch ${url} (last status ${lastStatus}).`);
}

/** Extract and parse the __NEXT_DATA__ JSON blob from a Linktree page. */
function parseNextData(html: string): Record<string, unknown> {
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('Could not find __NEXT_DATA__ on the page. Linktree may have changed its markup.');
    try {
        return JSON.parse(match[1]);
    } catch {
        throw new Error('Found __NEXT_DATA__ but failed to parse it as JSON.');
    }
}

/** Resolve a short/affiliate link to its final destination URL. */
async function resolveFinalUrl(url: string): Promise<string | null> {
    const { status, finalUrl } = await getPage(url, { maxRedirects: 10, timeout: 20_000 });
    if (status && finalUrl && finalUrl !== url) return finalUrl;
    return null;
}

// ---- Daraz product page parsing ------------------------------------------
// (Pure parsing helpers — isProductImage, extractImages, extractPreview,
// looksBlocked, isDarazProductUrl — live in ./scrape.ts so they're unit-tested.)

/**
 * Scrape a Daraz product starting from a Linktree short/affiliate link.
 * Price + list price come from the short-link preview page; the image gallery
 * comes from the real product page reached via the tracking redirect.
 *
 * A dead/expired short link redirects to a home/category/search/error page
 * instead of a product. We detect that by requiring the resolved page to be a
 * real Daraz product URL (`isDarazProductUrl`) and report `no-product` so the
 * importer surfaces it as broken rather than attaching a wrong image/title.
 */
async function scrapeDarazProduct(url: string): Promise<ProductDetails> {
    const empty: ProductDetails = {
        productName: null,
        price: null,
        originalPrice: null,
        discount: null,
        images: [],
        resolvedUrl: null,
        detailStatus: 'error',
    };

    // Step 1: fetch the link. For a short link this is the share/preview page;
    // for a full product link it's already the product page (PDP).
    let previewHtml = '';
    let previewFinalUrl = url;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const res = await getPage(url, { maxRedirects: 10, timeout: 30_000 });
        if (res.data) {
            previewHtml = res.data;
            previewFinalUrl = res.finalUrl;
            break;
        }
        if (attempt === 1) {
            await new Promise((r) => {
                setTimeout(r, 1_500);
            });
        } else {
            empty.detailStatus = res.status ? `http-${res.status}` : 'fetch-failed';
        }
    }
    if (!previewHtml) return empty;
    if (looksBlocked(previewHtml)) return { ...empty, detailStatus: 'blocked' };

    const preview = extractPreview(previewHtml);

    // Step 2: resolve to the actual product page. The share page's REDIRECTURL
    // (preview.trackingUrl) ALREADY is the canonical product URL, so capture it up
    // front: a blocked/failed PDP fetch (common from datacenter IPs) must still
    // yield the resolved product URL. The PDP fetch below is best-effort enrichment
    // for images/price/name only.
    let pdpHtml = '';
    let resolvedUrl: string | null =
        preview.trackingUrl && isDarazProductUrl(preview.trackingUrl) ? preview.trackingUrl : null;
    if (preview.trackingUrl) {
        const pdp = await getPage(preview.trackingUrl, { maxRedirects: 10, timeout: 30_000 });
        if (pdp.data) {
            pdpHtml = pdp.data;
            // Prefer the fetch's final URL when it lands on a real product page;
            // otherwise keep the canonical URL we already pulled from REDIRECTURL.
            if (isDarazProductUrl(pdp.finalUrl)) resolvedUrl = pdp.finalUrl;
        }
    } else if (isDarazProductUrl(previewFinalUrl)) {
        pdpHtml = previewHtml;
        resolvedUrl = previewFinalUrl;
    }

    // Broken link: it never resolved to a real Daraz product page.
    if (!isDarazProductUrl(resolvedUrl)) {
        return { ...empty, resolvedUrl: null, images: [], detailStatus: 'no-product' };
    }
    if (looksBlocked(pdpHtml)) return { ...empty, resolvedUrl, detailStatus: 'blocked' };

    // Single product image: the PDP's og:image, falling back to the share page's
    // og:image. Both live on Daraz CDN hosts validated by isProductImage.
    const ogImg = extractOgImage(pdpHtml) ?? preview.mainImage;
    const images = ogImg && isProductImage(ogImg) ? [ogImg] : [];

    // Price/name come from the short-link preview first; fall back to the PDP
    // HTML we already fetched (JSON-LD offers / inlined priceText / og:title),
    // which is why the actor no longer needs scraper-service to re-scrape.
    const price = preview.salePrice ?? preview.listPrice ?? extractPdpPrice(pdpHtml);
    const productName = preview.productName ?? extractPdpName(pdpHtml);
    const originalPrice =
        preview.salePrice && preview.listPrice && preview.salePrice !== preview.listPrice ? preview.listPrice : null;
    const gotSomething = Boolean(price) || images.length > 0;

    return {
        productName,
        price,
        originalPrice,
        discount: null,
        images,
        resolvedUrl,
        detailStatus: gotSomething ? 'ok' : 'no-data',
    };
}

/** Run an async mapper over items with a bounded concurrency. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    async function worker(): Promise<void> {
        while (cursor < items.length) {
            const idx = cursor;
            cursor += 1;
            results[idx] = await fn(items[idx], idx);
        }
    }
    const count = Math.max(1, Math.min(limit, items.length));
    const workers: Promise<void>[] = [];
    for (let w = 0; w < count; w += 1) workers.push(worker());
    await Promise.all(workers);
    return results;
}

// ---- Main flow ------------------------------------------------------------

log.info(`Fetching Linktree profile: ${cleanUrl}`);
const html = await fetchProfileHtml(cleanUrl);
const nextData = parseNextData(html);

const pageProps = ((nextData.props as Record<string, unknown>)?.pageProps ?? {}) as Record<string, unknown>;

// Linktree returns statusCode 404 in pageProps for missing/renamed/private profiles.
const statusCode = pageProps.statusCode as number | undefined;
if (statusCode && statusCode !== 200) {
    throw new Error(
        `Linktree returned status ${statusCode} for ${cleanUrl}. ` +
            'The profile may not exist, may be private, or may have been renamed. ' +
            'Double-check the username (including any trailing characters like "_").',
    );
}

const account = (pageProps.account ?? {}) as Record<string, unknown>;
const username = (pageProps.username as string) || (account.username as string) || '';

// Collect links from the main list plus any pinned links, de-duplicated by id.
const rawLinks: LinktreeLink[] = [
    ...((account.links as LinktreeLink[]) ?? []),
    ...((account.pinnedLinks as LinktreeLink[]) ?? []),
    ...((pageProps.links as LinktreeLink[]) ?? []),
];
const byId = new Map<number, LinktreeLink>();
for (const l of rawLinks) if (l && typeof l.id === 'number') byId.set(l.id, l);
const links = [...byId.values()];

// Map GROUP ids -> group title so we can label which section a link sits under.
const groupTitleById = new Map<number, string>();
for (const l of links) {
    if (l.type === 'GROUP') groupTitleById.set(l.id, l.title || '');
}

const filterMsg = filterTerm ? `Filtering by hostname containing "${filterTerm}".` : 'Returning ALL links.';
log.info(`Found ${links.length} total links on @${username}. ${filterMsg}`);

// Build the base rows: keep only real (non-GROUP) links with a URL that match the filter.
const scrapedAt = new Date().toISOString();
const baseRows: OutputLink[] = [];
for (const l of links) {
    if (l.type === 'GROUP') continue;
    const url = (l.url || '').trim();
    if (!url) continue;
    const domain = hostnameOf(url);
    if (filterTerm && !domain.includes(filterTerm)) continue;

    baseRows.push({
        profileUsername: username,
        title: l.title || '',
        url,
        expandedUrl: null,
        domain,
        type: l.type,
        group: l.parent?.id ? (groupTitleById.get(l.parent.id) ?? '') : '',
        position: l.position ?? 0,
        scrapedAt,
    });
}
baseRows.sort((a, b) => a.position - b.position);
log.info(`Matched ${baseRows.length} link(s).`);

// Optionally resolve short links and/or scrape product details (price + images).
if (needsExpansion && baseRows.length > 0) {
    const action = scrapeProductDetails ? 'Scraping product details for' : 'Expanding';
    log.info(`${action} ${baseRows.length} link(s) with concurrency ${maxConcurrency}...`);

    let done = 0;
    await mapPool(baseRows, maxConcurrency, async (row, idx) => {
        const patch: Partial<OutputLink> = {};

        // Product scraping is Daraz-specific; for any non-Daraz link just resolve its final URL.
        if (scrapeProductDetails && row.domain.includes('daraz')) {
            const details = await scrapeDarazProduct(row.url);
            // The product scrape discovers the real product URL via the tracking redirect.
            patch.expandedUrl = details.resolvedUrl;
            patch.productName = details.productName;
            patch.price = details.price;
            patch.originalPrice = details.originalPrice;
            patch.discount = details.discount;
            patch.images = details.images;
            patch.detailStatus = details.detailStatus;
        } else {
            patch.expandedUrl = await resolveFinalUrl(row.url);
        }
        Object.assign(baseRows[idx], patch);

        done += 1;
        if (done % 10 === 0 || done === baseRows.length) {
            log.info(`Processed ${done}/${baseRows.length} link(s).`);
        }
        return null;
    });

    if (scrapeProductDetails) {
        const ok = baseRows.filter((r) => r.detailStatus === 'ok').length;
        const blocked = baseRows.filter((r) => r.detailStatus === 'blocked').length;
        log.info(`Product details: ${ok} ok, ${blocked} blocked, ${baseRows.length - ok - blocked} other.`);
        if (blocked > 0) {
            log.warning(
                'Some product pages were blocked by Daraz bot protection. ' +
                    'Enable Apify Proxy with Nepal (NP) residential IPs for best results.',
            );
        }
    }
}

log.info(`Pushing ${baseRows.length} row(s) to the dataset.`);
await Actor.pushData(baseRows);

await Actor.setValue('SUMMARY', {
    profileUrl: cleanUrl,
    username,
    totalLinksOnProfile: links.filter((l) => l.type !== 'GROUP' && l.url).length,
    filter: filterTerm || '(none)',
    matchedLinks: baseRows.length,
    productDetailsScraped: scrapeProductDetails,
    scrapedAt,
});

log.info(
    `Done. ${baseRows.length} link(s) saved. Open the dataset and use "Export" to download as JSON, CSV, Excel, etc.`,
);

await Actor.exit();
