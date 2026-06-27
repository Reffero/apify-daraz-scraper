// Pure (network-free) parsing helpers for the Linktree → Daraz scraper.
// Kept separate from main.ts so they can be unit-tested without the Actor
// runtime (main.ts calls Actor.init() at import time).

/** Pick a hostname out of a URL, lower-cased; returns '' if not parseable. */
export function hostnameOf(url: string): string {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return '';
    }
}

/** Accept Daraz Nepal itself and its subdomains, without suffix-spoofed hosts. */
export function isDarazHost(url: string): boolean {
    const host = hostnameOf(url);
    return host === 'daraz.com.np' || host.endsWith('.daraz.com.np');
}

// Daraz canonical product URLs embed the product id as `-i<digits>` (optionally
// followed by `-s<digits>`), e.g. `.../foo-i123456789-s987654321.html`. This is
// the same pattern the backend uses to derive the dedup id (scraper-service
// linktree/normalize.ts), so gating on it keeps the actor and importer aligned.
export const DARAZ_PRODUCT_RE = /-i(\d+)(?:-s\d+)?\.html/i;

/**
 * True only when the URL is a real Daraz product page. Dead/expired short links
 * redirect to home, category, `/catalog`, `/search` or error pages — none of
 * which match — so this is how we tell a live product from a broken link.
 */
export function isDarazProductUrl(url: string | null | undefined): boolean {
    if (!url) return false;
    if (!isDarazHost(url)) return false;
    return DARAZ_PRODUCT_RE.test(url);
}

const CHROME_PATH_MARKERS = ['/domino/', '/imgextra/', '/icon', '/logo', '_NP-', '/g/tps/'];

/** True if a URL points at an actual product image rather than UI chrome. */
export function isProductImage(url: string): boolean {
    let u: URL;
    try {
        u = new URL(url);
    } catch {
        return false;
    }
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (CHROME_PATH_MARKERS.some((m) => path.includes(m))) return false;
    // Daraz serves product/share images from static-*.daraz.com.np under /p/ (the
    // og:image on share pages and the JSON-LD gallery both live here).
    if (host.endsWith('.daraz.com.np') && path.startsWith('/p/')) return true;
    if (host === 'img.drz.lazcdn.com' && path.includes('/p/')) return true;
    if (host === 'filebroker-cdn.lazada.sg' && path.startsWith('/kf/')) return true;
    if (host.endsWith('.slatic.net') && /\.(jpg|jpeg|png|webp)/.test(path) && !path.includes('/domino/')) return true;
    return false;
}

/** Normalise an image URL so the same asset at different sizes dedupes to one. */
export function imageKey(url: string): string {
    return url
        .replace(/_\d+x\d+q\d+\.(jpg|jpeg|png|webp)(_\.webp)?$/i, '')
        .replace(/\.(jpg|jpeg|png|webp)(_\.webp)?$/i, '')
        .replace(/\?.*$/, '');
}

const JSON_LD_RE = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

/** Pull a string image URL out of one JSON-LD `image` entry (string or {url}). */
function imageUrlFromNode(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
        const { url } = value as Record<string, unknown>;
        if (typeof url === 'string') return url;
    }
    return null;
}

/** Product-scoped fields pulled from one page's schema.org JSON-LD. */
interface JsonLdProduct {
    images: string[];
    name: string | null;
    price: string | null;
}

/** Pull `offers.price` / `offers.lowPrice` out of a Product node, as a string. */
function priceFromOffers(offers: unknown): string | null {
    if (!offers || typeof offers !== 'object') return null;
    const { price, lowPrice } = offers as Record<string, unknown>;
    const raw = price ?? lowPrice;
    if (typeof raw === 'string' && raw.trim()) return raw.trim();
    if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
    return null;
}

/** Parse every JSON-LD block on the page into one product-scoped result. */
function extractJsonLdProduct(html: string): JsonLdProduct {
    const out: JsonLdProduct = { images: [], name: null, price: null };
    const collect = (parsed: unknown): void => {
        if (Array.isArray(parsed)) {
            for (const item of parsed) collect(item);
            return;
        }
        if (!parsed || typeof parsed !== 'object') return;

        const node = parsed as Record<string, unknown>;
        if (Array.isArray(node['@graph'])) {
            for (const child of node['@graph']) collect(child);
        }

        const type = node['@type'];
        const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
        if (!isProduct) return;

        const entries = Array.isArray(node.image) ? node.image : [node.image];
        for (const entry of entries) {
            const url = imageUrlFromNode(entry);
            if (url) out.images.push(url);
        }
        out.name ||= decodeEntities(typeof node.name === 'string' ? node.name : null);
        out.price ||= priceFromOffers(node.offers);
    };

    for (const match of html.matchAll(JSON_LD_RE)) {
        const raw = match[1]?.trim();
        if (!raw) continue;
        try {
            collect(JSON.parse(raw));
        } catch {
            // ignore malformed JSON-LD blocks
        }
    }
    return out;
}

/**
 * Product images from the page's schema.org JSON-LD. JSON-LD `image` is scoped
 * to THE product (mirrors how the existing Daraz scraper reads JSON-LD), so it
 * never pulls in "you may also like" / recommendation thumbnails.
 */
export function extractJsonLdImages(html: string): string[] {
    return extractJsonLdProduct(html).images;
}

/** First og:image content on the page, or null. */
export function extractOgImage(html: string): string | null {
    return html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? null;
}

/**
 * Collect product image URLs from a Daraz product page's HTML. Prefers the
 * product-scoped JSON-LD gallery, then the og:image, and deliberately does NOT
 * brute-force every image URL on the page — that was the source of unrelated
 * recommendation images leaking into the gallery.
 */
export function extractImages(html: string): string[] {
    const found = new Map<string, string>();
    const add = (raw: string | null | undefined) => {
        if (!raw) return;
        const url = raw.replace(/&amp;/g, '&');
        if (!isProductImage(url)) return;
        const key = imageKey(url);
        if (!found.has(key)) found.set(key, url);
    };

    for (const url of extractJsonLdImages(html)) add(url);
    if (found.size === 0) add(extractOgImage(html));

    return [...found.values()];
}

/** First og:title content on the page, or null. */
export function extractOgTitle(html: string): string | null {
    return html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? null;
}

/** Contents of the <title> tag, or null. */
function extractTitleTag(html: string): string | null {
    return html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? null;
}

/**
 * Best-effort product name from a Daraz PDP: the product-scoped JSON-LD `name`
 * first, then og:title, then the <title> tag. Used as a fallback when the
 * short-link preview page didn't carry a "Product Name:" description.
 */
/** Drop the trailing " | Daraz.com.np" store suffix Daraz appends to og:title/<title>. */
function stripDarazSuffix(name: string | null): string | null {
    if (!name) return name;
    return name.replace(/\s*\|\s*Daraz\.com\.np\s*$/i, '').trim() || null;
}

export function extractPdpName(html: string): string | null {
    return (
        extractJsonLdProduct(html).name ??
        stripDarazSuffix(decodeEntities(extractOgTitle(html))) ??
        stripDarazSuffix(decodeEntities(extractTitleTag(html)))
    );
}

// Daraz inlines the SSR price as `"priceText":"Rs. 1,234"` and a bare
// `"price":"1234"`; these mirror the proven fallbacks in scraper-service's
// affiliate-scraper. JSON-LD offers are read separately via extractJsonLdProduct.
const PRICE_TEXT_RE = /"priceText":"([^"]+)"/i;
// Daraz's PDP tracking JSON inlines the authoritative price as a pre-formatted
// `"pdt_price":"Rs. 1,234"` — more reliable than scanning for any visible Rs. amount.
const PDT_PRICE_RE = /"pdt_price":"([^"]+)"/i;
const RAW_PRICE_RE = /"price":"([^"]+)"/i;
const PRICE_RE = '(?:Rs\\.?|NPR|रू)\\s?[\\d,]+(?:\\.\\d+)?';

/**
 * Best-effort price from a Daraz PDP, layering the strategies that reliably hit
 * across Daraz's SSR variants: inlined `priceText`, JSON-LD `offers.price`/
 * `lowPrice`, the bare `"price"` field, then any visible `Rs.`/`NPR` amount.
 * Always returned as a display string (prefixes `Rs. ` when the source is bare).
 */
export function extractPdpPrice(html: string): string | null {
    const priceText = decodeEntities(html.match(PRICE_TEXT_RE)?.[1]);
    if (priceText) return priceText;

    const pdtPrice = decodeEntities(html.match(PDT_PRICE_RE)?.[1]);
    if (pdtPrice) return /^rs|npr|रू/i.test(pdtPrice) ? pdtPrice : `Rs. ${pdtPrice}`;

    const jsonLdPrice = extractJsonLdProduct(html).price;
    if (jsonLdPrice) return /^rs|npr|रू/i.test(jsonLdPrice) ? jsonLdPrice : `Rs. ${jsonLdPrice}`;

    const rawPrice = decodeEntities(html.match(RAW_PRICE_RE)?.[1]);
    if (rawPrice) return /^rs|npr|रू/i.test(rawPrice) ? rawPrice : `Rs. ${rawPrice}`;

    return html.match(new RegExp(PRICE_RE, 'i'))?.[0] ?? null;
}

/** Decode the few HTML entities Daraz uses in titles/descriptions. */
export function decodeEntities(s: string | null | undefined): string | null {
    if (!s) return null;
    return (
        s
            .replace(/&amp;/g, '&')
            .replace(/&#39;|&apos;/g, "'")
            .replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .trim() || null
    );
}

/** Data extracted from a Daraz short-link "preview" page (has price + main image). */
export interface PreviewData {
    productName: string | null;
    salePrice: string | null;
    listPrice: string | null;
    mainImage: string | null;
    trackingUrl: string | null;
}

/** Parse the share/preview page that a Daraz short link returns. */
export function extractPreview(html: string): PreviewData {
    const desc =
        html.match(
            /<meta[^>]+(?:name|property)=["'](?:og:description|description)["'][^>]+content=["']([\s\S]*?)["']\s*\/?>/i,
        )?.[1] || '';

    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
    const productName =
        decodeEntities(desc.match(/Product Name:\s*([\s\S]*?)(?:Product Price:|$)/i)?.[1]) || decodeEntities(ogTitle);

    const listPrice = desc.match(new RegExp(`Product Price:\\s*(${PRICE_RE})`, 'i'))?.[1] || null;
    const salePrice = desc.match(new RegExp(`Discount Price:\\s*(${PRICE_RE})`, 'i'))?.[1] || null;

    const ogImage = extractOgImage(html);

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
export function looksBlocked(html: string): boolean {
    if (html.length < 800) return true;
    return /punish|slider-captcha|verify you are human|_____tmd_____/i.test(html);
}
