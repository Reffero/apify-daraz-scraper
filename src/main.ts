// Apify SDK - toolkit for building Apify Actors (https://docs.apify.com/sdk/js/).
import { Actor, log } from 'apify';
// Axios - Promise based HTTP client for node.js (https://axios-http.com/docs/intro).
import axios from 'axios';
// Agent for routing axios requests through an HTTP(S) proxy.
import { HttpsProxyAgent } from 'https-proxy-agent';

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
    scrapeProductDetails = false,
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
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

/** Pick a hostname out of a URL, lower-cased; returns '' if not parseable. */
function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

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

const CHROME_PATH_MARKERS = ['/domino/', '/imgextra/', '/icon', '/logo', '_NP-', '/g/tps/'];

/** True if a URL points at an actual product image rather than UI chrome. */
function isProductImage(url: string): boolean {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (CHROME_PATH_MARKERS.some((m) => path.includes(m))) return false;
    if (host === 'img.drz.lazcdn.com' && path.includes('/p/')) return true;
    if (host === 'filebroker-cdn.lazada.sg' && path.startsWith('/kf/')) return true;
    if (host.endsWith('.slatic.net') && /\.(jpg|jpeg|png|webp)/.test(path) && !path.includes('/domino/')) return true;
    return false;
}

/** Normalise an image URL so the same asset at different sizes dedupes to one. */
function imageKey(url: string): string {
    return url
        .replace(/_\d+x\d+q\d+\.(jpg|jpeg|png|webp)(_\.webp)?$/i, '')
        .replace(/\.(jpg|jpeg|png|webp)(_\.webp)?$/i, '')
        .replace(/\?.*$/, '');
}

/** Collect product image URLs from a Daraz product page's HTML. */
function extractImages(html: string): string[] {
    const found = new Map<string, string>();
    const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
    if (og && isProductImage(og[1])) found.set(imageKey(og[1]), og[1]);
    const urls = html.match(/https?:\/\/[^"'\\\s)<>]+/g) || [];
    for (const raw of urls) {
        const url = raw.replace(/&amp;/g, '&');
        if (isProductImage(url)) {
            const k = imageKey(url);
            if (!found.has(k)) found.set(k, url);
        }
    }
    return [...found.values()];
}

/** Decode the few HTML entities Daraz uses in titles/descriptions. */
function decodeEntities(s: string | null | undefined): string | null {
    if (!s) return null;
    return s
        .replace(/&amp;/g, '&')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim() || null;
}

const PRICE_RE = '(?:Rs\\.?|NPR|रू)\\s?[\\d,]+(?:\\.\\d+)?';

/** Data extracted from a Daraz short-link "preview" page (has price + main image). */
interface PreviewData {
    productName: string | null;
    salePrice: string | null;
    listPrice: string | null;
    mainImage: string | null;
    trackingUrl: string | null;
}

/** Parse the share/preview page that a Daraz short link returns. */
function extractPreview(html: string): PreviewData {
    const desc =
        html.match(
            /<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]+content=["']([\s\S]*?)["']\s*\/?>/i,
        )?.[1] || '';

    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
    const productName =
        decodeEntities(desc.match(/Product Name:\s*([\s\S]*?)(?:Product Price:|$)/i)?.[1]) || decodeEntities(ogTitle);

    const listPrice = desc.match(new RegExp(`Product Price:\\s*(${PRICE_RE})`, 'i'))?.[1] || null;
    const salePrice = desc.match(new RegExp(`Discount Price:\\s*(${PRICE_RE})`, 'i'))?.[1] || null;

    const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] || null;

    // The preview embeds a c.daraz.com.np tracking URL that redirects to the real product page.
    const track =
        html.match(/https?:\/\/c\.daraz\.com\.np\/t\/[^"'\\\s)<>]+/i)?.[0] ||
        html.match(/REDIRECTURL\s*=\s*new URL\(['"]([^'"]+)['"]/i)?.[1] ||
        null;

    return {
        productName,
        salePrice,
        listPrice,
        mainImage: ogImage,
        trackingUrl: track ? track.replace(/&amp;/g, '&') : null,
    };
}

/** Detect Daraz bot-challenge / punish pages so we can report them clearly. */
function looksBlocked(html: string): boolean {
    if (html.length < 800) return true;
    return /punish|slider-captcha|verify you are human|_____tmd_____/i.test(html);
}

/**
 * Scrape a Daraz product starting from a Linktree short/affiliate link.
 * Price + list price come from the short-link preview page; the full image
 * gallery comes from the real product page reached via the tracking redirect.
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

    // Step 1: the preview page (carries the price + main image).
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

    // Step 2: follow the tracking redirect to the real product page for the gallery.
    let images: string[] = [];
    let resolvedUrl = previewFinalUrl;
    if (preview.trackingUrl) {
        const pdp = await getPage(preview.trackingUrl, { maxRedirects: 10, timeout: 30_000 });
        if (pdp.data) {
            resolvedUrl = pdp.finalUrl;
            images = extractImages(pdp.data);
        }
    }
    // Fall back to the preview's main image if the gallery couldn't be read.
    if (images.length === 0 && preview.mainImage && isProductImage(preview.mainImage)) {
        images = [preview.mainImage];
    }

    const price = preview.salePrice || preview.listPrice;
    const originalPrice =
        preview.salePrice && preview.listPrice && preview.salePrice !== preview.listPrice ? preview.listPrice : null;
    const gotSomething = Boolean(price) || images.length > 0;

    return {
        productName: preview.productName,
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

const filterMsg = filterTerm
    ? `Filtering by hostname containing "${filterTerm}".`
    : 'Returning ALL links.';
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
        group: l.parent?.id ? groupTitleById.get(l.parent.id) ?? '' : '',
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
