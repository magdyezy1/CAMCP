# The measurement hub

**Measurement** checks whether your conversion tracking works, across your platforms, without changing anything. It
reads configuration and recent activity. It never sends a test event, never changes a tag, and never calls a
platform's conversion upload.

## What you can check

Choose a task at the top of the page:

- **Measurement evidence ledger**: for one account, property, pixel or app, how far the evidence goes, layer by
  layer: configuration, activity the platform observed, the platform's diagnostics, a trace you supply, consent, and
  attribution settings. Each layer says *Observed*, *Unknown*, *Unavailable* or *Not applicable*, with the reason. It
  covers Google Ads, Google Analytics 4, Meta pixels and datasets, Snapchat and TikTok pixels, Search Console and
  Adjust.
- **Google Ads conversion goals**: the goals and primary conversion actions a campaign would bid on.
- **GA4 property configuration** and **Recent GA4 events**: the property's key events, custom definitions and data
  streams, and the key events it received recently.
- **Google Tag Manager configuration audit**: findings in the published container, such as a tag without a trigger or
  a consent setting to check.
- **LinkedIn conversion settings**: each conversion's method, attribution windows and what it collects.
- **Inspect a sanitized event trace**: paste a trace, or convert a dataLayer export or HAR file in your browser. It is
  checked on your computer and is never uploaded.

## How to read the results

- *Unknown* means AMCP could not prove it either way: a read failed, came back partial or was limited by the
  platform. It is not, by itself, a fault in your tracking.
- Configuration does not prove that conversions arrive. Look at the activity layer, and at the platform itself, before
  you let a campaign bid on a conversion goal.
- Nothing on this page changes your accounts. Changes to tags, consent settings or conversion goals are prepared as
  drafts and reviews like every other change.

Next: [when something needs attention](recovery.md).
