import { describe, expect, it } from 'vitest';

import {
    extractImages,
    extractJsonLdImages,
    extractPdpName,
    extractPdpPrice,
    extractPreview,
    isDarazHost,
    isDarazProductUrl,
    isProductImage,
} from '../src/scrape.js';

describe('isDarazHost', () => {
    it('accepts Daraz Nepal links and rejects lookalike and unrelated hosts', () => {
        expect(isDarazHost('https://s.daraz.com.np/s.example')).toBe(true);
        expect(isDarazHost('https://www.daraz.com.np/products/example-i123.html')).toBe(true);
        expect(isDarazHost('https://evildaraz.com.np/s.example')).toBe(false);
        expect(isDarazHost('https://example.com/?url=daraz.com.np')).toBe(false);
    });
});

describe('isDarazProductUrl', () => {
    it('accepts real Daraz product URLs', () => {
        expect(isDarazProductUrl('https://www.daraz.com.np/products/foo-i123456789-s987654321.html')).toBe(true);
        expect(isDarazProductUrl('https://www.daraz.com.np/products/bar-i555.html')).toBe(true);
    });

    it('rejects broken/expired links that redirect off the product page', () => {
        expect(isDarazProductUrl('https://www.daraz.com.np/')).toBe(false);
        expect(isDarazProductUrl('https://www.daraz.com.np/catalog/?q=earbuds')).toBe(false);
        expect(isDarazProductUrl('https://www.daraz.com.np/shop-electronics/')).toBe(false);
        expect(isDarazProductUrl('https://s.daraz.com.np/s.qGoh')).toBe(false);
        expect(isDarazProductUrl(null)).toBe(false);
        expect(isDarazProductUrl('not a url')).toBe(false);
    });

    it('rejects non-Daraz hosts even with a product-looking path', () => {
        expect(isDarazProductUrl('https://evil.example.com/foo-i123.html')).toBe(false);
    });
});

describe('isProductImage', () => {
    it('accepts real product CDN images and rejects UI chrome', () => {
        expect(isProductImage('https://img.drz.lazcdn.com/static/np/p/abc.png_720x720q80.png')).toBe(true);
        expect(isProductImage('https://np-live-21.slatic.net/kf/Sxyz.png')).toBe(true);
        expect(isProductImage('https://static-01.daraz.com.np/p/f02363fada0bda043091e70ad7587518.jpg')).toBe(true);
        expect(isProductImage('https://img.drz.lazcdn.com/g/tps/logo.png')).toBe(false);
        expect(isProductImage('https://static-01.daraz.com.np/icon/logo.png')).toBe(false);
        expect(isProductImage('https://laz-img-cdn.alicdn.com/domino/banner.jpg')).toBe(false);
    });
});

// A realistic trimmed Daraz PDP: schema.org Product JSON-LD holds the product's
// own gallery, while the page body also contains a recommendation carousel.
const PDP_HTML = `
<html><head>
<meta property="og:image" content="https://img.drz.lazcdn.com/static/np/p/main.png_720x720q80.png" />
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Ultima Prime Earbuds",
  "image": [
    "https://img.drz.lazcdn.com/static/np/p/gallery1.png_720x720q80.png",
    "https://img.drz.lazcdn.com/static/np/p/gallery2.png_200x200q80.png"
  ],
  "offers": { "@type": "Offer", "price": "3499", "priceCurrency": "NPR" }
}
</script>
</head>
<body>
<div class="recommendations">
  <img src="https://img.drz.lazcdn.com/static/np/p/RECOMMENDED-other-product.png_100x100q80.png" />
  <img src="https://img.drz.lazcdn.com/static/np/p/ANOTHER-recommendation.png_100x100q80.png" />
</div>
</body></html>`;

describe('extractJsonLdImages', () => {
    it('reads product images from JSON-LD only', () => {
        const imgs = extractJsonLdImages(PDP_HTML);
        expect(imgs).toContain('https://img.drz.lazcdn.com/static/np/p/gallery1.png_720x720q80.png');
        expect(imgs).toContain('https://img.drz.lazcdn.com/static/np/p/gallery2.png_200x200q80.png');
        expect(imgs.some((u) => u.includes('RECOMMENDED'))).toBe(false);
    });

    it('handles @graph and array-shaped JSON-LD', () => {
        const html = `<script type="application/ld+json">
        {"@graph":[{"@type":"WebPage"},{"@type":"Product","image":"https://img.drz.lazcdn.com/static/np/p/g.png_720x720q80.png"}]}
        </script>`;
        expect(extractJsonLdImages(html)).toEqual(['https://img.drz.lazcdn.com/static/np/p/g.png_720x720q80.png']);
    });
});

describe('extractImages', () => {
    it('returns the JSON-LD product gallery and excludes recommendation images', () => {
        const imgs = extractImages(PDP_HTML);
        // Both gallery images dedupe to distinct assets; recommendations are gone.
        expect(imgs).toEqual([
            'https://img.drz.lazcdn.com/static/np/p/gallery1.png_720x720q80.png',
            'https://img.drz.lazcdn.com/static/np/p/gallery2.png_200x200q80.png',
        ]);
        expect(imgs.some((u) => u.includes('RECOMMENDED'))).toBe(false);
        expect(imgs.some((u) => u.includes('ANOTHER'))).toBe(false);
    });

    it('falls back to og:image when there is no JSON-LD gallery', () => {
        const html = `<head><meta property="og:image" content="https://img.drz.lazcdn.com/static/np/p/only.png_720x720q80.png" /></head>`;
        expect(extractImages(html)).toEqual(['https://img.drz.lazcdn.com/static/np/p/only.png_720x720q80.png']);
    });

    it('returns nothing for a page with no product images (broken/empty page)', () => {
        const html = `<head><meta property="og:image" content="https://img.drz.lazcdn.com/g/tps/logo.png" /></head><body></body>`;
        expect(extractImages(html)).toEqual([]);
    });
});

describe('extractPdpName', () => {
    it('prefers the product-scoped JSON-LD name', () => {
        expect(extractPdpName(PDP_HTML)).toBe('Ultima Prime Earbuds');
    });

    it('falls back to og:title then <title>', () => {
        expect(extractPdpName(`<head><meta property="og:title" content="Cool Watch &amp; Strap" /></head>`)).toBe(
            'Cool Watch & Strap',
        );
        expect(extractPdpName(`<head><title>Plain Title | Daraz</title></head>`)).toBe('Plain Title | Daraz');
        expect(extractPdpName(`<head></head><body></body>`)).toBeNull();
    });
});

describe('extractPdpPrice', () => {
    it('reads JSON-LD offers price and prefixes Rs.', () => {
        // PDP_HTML's JSON-LD offer is a bare "3499".
        expect(extractPdpPrice(PDP_HTML)).toBe('Rs. 3499');
    });

    it('prefers an inlined priceText over everything', () => {
        expect(extractPdpPrice(`<script>{"priceText":"Rs. 1,299"}</script>`)).toBe('Rs. 1,299');
    });

    it('reads the pdt_price tracking field, beating a stray visible Rs. amount', () => {
        const html = `<div>Save Rs. 100 today</div><script>{"pdt_price":"Rs. 3,900"}</script>`;
        expect(extractPdpPrice(html)).toBe('Rs. 3,900');
    });

    it('falls back to a bare "price" field, then a visible Rs. amount', () => {
        expect(extractPdpPrice(`<script>var x = {"price":"2499"};</script>`)).toBe('Rs. 2499');
        expect(extractPdpPrice(`<div class="pdp-price">Rs.4,999</div>`)).toBe('Rs.4,999');
        expect(extractPdpPrice(`<body>no price here</body>`)).toBeNull();
    });
});

describe('extractPreview', () => {
    it('parses product name, prices and tracking URL from a share page', () => {
        const html = `<head>
        <meta property="og:title" content="Ultima Earbuds" />
        <meta property="og:description" content="Product Name: Ultima Prime Earbuds Product Price: Rs.4,499 Discount Price: Rs.3,499" />
        <meta property="og:image" content="https://img.drz.lazcdn.com/static/np/p/main.png_720x720q80.png" />
        <script>var x = 'https://c.daraz.com.np/t/abc123?redirect=1';</script>
        </head>`;
        const preview = extractPreview(html);
        expect(preview.productName).toBe('Ultima Prime Earbuds');
        expect(preview.listPrice).toBe('Rs.4,499');
        expect(preview.salePrice).toBe('Rs.3,499');
        expect(preview.trackingUrl).toBe('https://c.daraz.com.np/t/abc123?redirect=1');
        expect(preview.mainImage).toBe('https://img.drz.lazcdn.com/static/np/p/main.png_720x720q80.png');
    });

    it('extracts the canonical product URL from a REDIRECTURL share page', () => {
        // Real s.daraz.com.np share pages carry no c.daraz.com.np/t/ link and an
        // empty og:description — the product URL only lives in the JS REDIRECTURL.
        const productUrl =
            'https://www.daraz.com.np/products/erke-jogging-shoes-i1512958463-s12352624059.html?from_affiliate=1&laz_token=abc';
        const html = `<head>
        <meta property="og:image" content="https://img.alicdn.com/imgextra/i4/logo.png" />
        <script>REDIRECTURL = new URL('${productUrl}'); window.location = REDIRECTURL;</script>
        </head>`;
        const preview = extractPreview(html);
        expect(preview.trackingUrl).toBe(productUrl);
        // This is what main.ts now uses to populate expandedUrl even when the PDP
        // fetch is blocked from a datacenter IP.
        expect(isDarazProductUrl(preview.trackingUrl)).toBe(true);
    });
});
