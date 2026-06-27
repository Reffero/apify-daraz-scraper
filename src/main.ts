import { setTimeout as delay } from 'node:timers/promises';

import { Actor, log } from 'apify';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

import {
    extractOgImage,
    extractPdpName,
    extractPdpPrice,
    extractPreview,
    isDarazHost,
    isDarazProductUrl,
    isProductImage,
    looksBlocked,
} from './scrape.js';

interface Input {
    profileUrl: string;
}

interface LinktreeLink {
    id: number;
    type: string;
    title: string;
    url: string;
    position: number;
}

interface ProductDetails {
    productName: string | null;
    price: string | null;
    ogImage: string | null;
}

interface OutputRow extends ProductDetails {
    affiliateUrl: string;
    status: 'valid' | 'invalid';
}

const BROWSER_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
};

await Actor.init();

Actor.on('aborting', async () => {
    log.warning('Actor is aborting; allowing storage operations to finish.');
    await delay(1000);
    await Actor.exit();
});

const input = await Actor.getInput<Input>();
if (!input?.profileUrl || !/^https?:\/\/(www\.)?linktr\.ee\/.+/i.test(input.profileUrl.trim())) {
    throw new Error('"profileUrl" must be a Linktree URL such as https://linktr.ee/Razeemaharjan.');
}

const profileUrl = input.profileUrl.trim().split('?')[0].replace(/\/+$/, '');

let proxyConfiguration: Awaited<ReturnType<typeof Actor.createProxyConfiguration>>;
try {
    proxyConfiguration = await Actor.createProxyConfiguration({ useApifyProxy: true });
} catch (error) {
    log.warning(`Apify Proxy is unavailable; continuing directly: ${(error as Error).message}`);
    proxyConfiguration = undefined;
}

function proxyAgents(proxyUrl: string) {
    const agent = new HttpsProxyAgent(proxyUrl);
    return { httpAgent: agent, httpsAgent: agent };
}

async function getOnce(
    url: string,
    options: { maxRedirects?: number; timeout?: number },
    proxyUrl?: string,
): Promise<{ status: number; html: string; finalUrl: string }> {
    try {
        const response = await axios.get<string>(url, {
            headers: BROWSER_HEADERS,
            timeout: options.timeout ?? 30_000,
            maxRedirects: options.maxRedirects ?? 10,
            responseType: 'text',
            validateStatus: () => true,
            ...(proxyUrl ? { proxy: false as const, ...proxyAgents(proxyUrl) } : {}),
        });
        return {
            status: response.status,
            html: typeof response.data === 'string' ? response.data : '',
            finalUrl: response.request?.res?.responseUrl ?? url,
        };
    } catch (error) {
        log.debug(`GET failed for ${url}: ${(error as Error).message}`);
        return { status: 0, html: '', finalUrl: url };
    }
}

async function getPage(
    url: string,
    options: { maxRedirects?: number; timeout?: number; useProxy?: boolean } = {},
): Promise<{ status: number; html: string; finalUrl: string }> {
    const proxyUrl = options.useProxy !== false && proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
    const response = await getOnce(url, options, proxyUrl);
    if (proxyUrl && (response.status === 0 || response.status >= 500)) {
        return getOnce(url, options);
    }
    return response;
}

async function fetchProfileHtml(): Promise<string> {
    let lastStatus = 0;
    for (let attempt = 1; attempt <= 4; attempt += 1) {
        const response = await getPage(profileUrl, { useProxy: false });
        if (response.status >= 200 && response.status < 300 && response.html) return response.html;
        lastStatus = response.status;
        log.warning(`Linktree fetch attempt ${attempt}/4 returned status ${response.status}.`);
        if (attempt < 4) await delay(attempt * 2000);
    }
    throw new Error(`Failed to fetch ${profileUrl} (last status ${lastStatus}).`);
}

function parseNextData(html: string): Record<string, unknown> {
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('Linktree did not provide its embedded profile data.');
    try {
        return JSON.parse(match[1]);
    } catch {
        throw new Error('Linktree returned malformed embedded profile data.');
    }
}

async function scrapeProduct(affiliateUrl: string): Promise<ProductDetails> {
    const empty: ProductDetails = { productName: null, price: null, ogImage: null };
    let share = await getPage(affiliateUrl);
    if (!share.html) {
        await delay(1500);
        share = await getPage(affiliateUrl);
    }
    if (!share.html || looksBlocked(share.html)) return empty;

    const preview = extractPreview(share.html);
    let productUrl: string | null = null;
    let productHtml = '';

    if (preview.trackingUrl) {
        if (isDarazProductUrl(preview.trackingUrl)) productUrl = preview.trackingUrl;
        const product = await getPage(preview.trackingUrl);
        productHtml = product.html;
        if (isDarazProductUrl(product.finalUrl)) productUrl = product.finalUrl;
    } else if (isDarazProductUrl(share.finalUrl)) {
        productUrl = share.finalUrl;
        productHtml = share.html;
    }

    if (!productUrl || !productHtml || looksBlocked(productHtml)) return empty;

    const rawImage = extractOgImage(productHtml) ?? preview.mainImage;
    const ogImage = rawImage && isProductImage(rawImage) ? rawImage.replace(/&amp;/g, '&') : null;

    return {
        productName: preview.productName ?? extractPdpName(productHtml),
        price: preview.salePrice ?? preview.listPrice ?? extractPdpPrice(productHtml),
        ogImage,
    };
}

async function mapPool<T, R>(items: T[], limit: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length);
    let cursor = 0;
    async function worker(): Promise<void> {
        while (cursor < items.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await mapper(items[index]);
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            await worker();
        }),
    );
    return results;
}

log.info(`Fetching Linktree profile: ${profileUrl}`);
const nextData = parseNextData(await fetchProfileHtml());
const pageProps = ((nextData.props as Record<string, unknown>)?.pageProps ?? {}) as Record<string, unknown>;
const statusCode = pageProps.statusCode as number | undefined;
if (statusCode && statusCode !== 200) {
    throw new Error(`Linktree returned status ${statusCode}. The profile may not exist or may be private.`);
}

const account = (pageProps.account ?? {}) as Record<string, unknown>;
const rawLinks: LinktreeLink[] = [
    ...((account.links as LinktreeLink[]) ?? []),
    ...((account.pinnedLinks as LinktreeLink[]) ?? []),
    ...((pageProps.links as LinktreeLink[]) ?? []),
];

const uniqueLinks = new Map<string, LinktreeLink>();
for (const link of rawLinks) {
    const url = link?.url?.trim();
    if (link?.type === 'GROUP' || !url || !isDarazHost(url)) continue;
    if (!uniqueLinks.has(url)) uniqueLinks.set(url, link);
}
const links = [...uniqueLinks.values()].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
log.info(`Found ${links.length} unique Daraz affiliate link(s).`);

let processed = 0;
const rows = await mapPool(links, 5, async (link): Promise<OutputRow> => {
    const affiliateUrl = link.url.trim();
    let details: ProductDetails = { productName: null, price: null, ogImage: null };
    try {
        details = await scrapeProduct(affiliateUrl);
    } catch (error) {
        log.warning(`Could not process ${affiliateUrl}: ${(error as Error).message}`);
    }
    processed += 1;
    log.info(`Processed ${processed}/${links.length} Daraz link(s).`);
    const valid = Boolean(details.productName && details.price && details.ogImage);
    return {
        affiliateUrl,
        productName: valid ? details.productName : null,
        price: valid ? details.price : null,
        ogImage: valid ? details.ogImage : null,
        status: valid ? 'valid' : 'invalid',
    };
});

await Actor.pushData(rows);
const validCount = rows.filter((row) => row.status === 'valid').length;
log.info(`Done. Saved ${validCount} valid and ${rows.length - validCount} invalid link(s).`);

await Actor.exit();
