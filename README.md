## What does Linktree Daraz Affiliate Scraper do?

**Linktree Daraz Affiliate Scraper** reads a public [Linktree](https://linktr.ee/) profile and returns every Daraz Nepal affiliate link together with its product name, current displayed price, and Open Graph image. Paste a profile URL such as `https://linktr.ee/Razeemaharjan` into the Input tab to try it.

Runs on the Apify platform can be started through the Console or API, scheduled, monitored, and connected to other services. Apify storage also makes the results easy to download in common formats. The Actor keeps broken affiliate links in the output and labels them `invalid`, so missing or expired links do not silently disappear.

## Why use Linktree Daraz Affiliate Scraper?

Use this Actor to audit a creator's affiliate catalog, import product cards into another application, check for expired promotional links, or build a structured product feed from a Linktree page. Each link is handled independently, so one unavailable product does not prevent the other results from being collected.

## How to scrape Daraz links from Linktree

1. Open the Actor in Apify Console.
2. Enter the complete public Linktree profile URL.
3. Click **Start** and wait for the run to finish.
4. Open the run's **Output** or **Dataset** tab.
5. Export or integrate the resulting product records.

No selectors, filters, or concurrency settings are required. The Actor automatically identifies Daraz Nepal links and resolves short affiliate URLs internally.

## Input

The Input tab contains one required field:

| Field        | Type   | Description                                                                     |
| ------------ | ------ | ------------------------------------------------------------------------------- |
| `profileUrl` | string | Full public Linktree profile URL, for example `https://linktr.ee/Razeemaharjan` |

Example:

```json
{
    "profileUrl": "https://linktr.ee/Razeemaharjan"
}
```

## Output

Each dataset item represents one unique Daraz affiliate URL found on the profile:

```json
[
    {
        "affiliateUrl": "https://s.daraz.com.np/s.example",
        "productName": "Example wireless earbuds",
        "price": "Rs. 3,499",
        "ogImage": "https://img.drz.lazcdn.com/static/np/p/example.jpg",
        "status": "valid"
    },
    {
        "affiliateUrl": "https://s.daraz.com.np/s.expired",
        "productName": null,
        "price": null,
        "ogImage": null,
        "status": "invalid"
    }
]
```

You can download the dataset in various formats such as JSON, HTML, CSV, or Excel.

## Data table

| Field          | Description                                                         |
| -------------- | ------------------------------------------------------------------- |
| `affiliateUrl` | Original Daraz affiliate link found on Linktree                     |
| `productName`  | Daraz product name, or `null` for an invalid link                   |
| `price`        | Display-formatted selling price, or `null`                          |
| `ogImage`      | Validated product Open Graph image URL, or `null`                   |
| `status`       | `valid` when all product fields were extracted; otherwise `invalid` |

The resolved Daraz product URL is used internally for validation but is not included in output.

## How much does it cost to scrape Linktree and Daraz?

Cost depends mainly on the number of Daraz links and the proxy traffic needed to access their product pages. Small Linktree profiles generally require only a short run. Apify's free tier may be enough for occasional small jobs; check your current Apify plan and usage limits for exact pricing. Larger or frequent audits should be tested with a representative profile before scheduling.

## Tips and advanced options

Daraz may block datacenter traffic or ask for human verification. On Apify, the Actor attempts to use Apify Proxy and falls back to a direct connection when proxy access is unavailable. A blocked response is retained as an `invalid` row rather than guessed from incomplete data.

For reliable monitoring, schedule repeat runs and compare records by `affiliateUrl`. If a previously valid row becomes invalid, verify the link manually before removing it because temporary blocking can look like an expired link.

## FAQ, disclaimers, and support

**Why is a link marked invalid?** It may be expired, lead to a campaign instead of a product, be temporarily blocked, or lack a product name, price, or image.

**Does the Actor modify affiliate links?** No. `affiliateUrl` is exactly the link collected from Linktree; redirect resolution is internal.

Only scrape public pages and ensure your use complies with Linktree's and Daraz's terms, robots policies, and applicable law. Product prices and availability can change after a run. Use the Actor's **Issues** tab to report reproducible problems or request a custom integration.
