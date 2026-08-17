import fs from "node:fs";
import path from "node:path";

const githubLogin = process.env.GITHUB_LOGIN || "azizullahaziz";
const githubToken = process.env.GITHUB_TOKEN;

if (!githubToken) {
  throw new Error("GITHUB_TOKEN is required.");
}

const now = new Date();

// Build 12 calendar months: from start of (currentMonth - 11) through end of currentMonth
const months = [];
for (let index = 11; index >= 0; index--) {
  const date = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1)
  );
  months.push({
    key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
    label: date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
    year: date.getUTCFullYear(),
    pullRequests: 0,
    reviews: 0,
  });
}

const firstMonth = months[0];
const lastMonth = months[months.length - 1];
const rangeStart = `${firstMonth.year}-${firstMonth.key.slice(5)}-01T00:00:00Z`;
const lastDateObj = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
);
const rangeEnd = `${lastDateObj.getUTCFullYear()}-${String(lastDateObj.getUTCMonth() + 1).padStart(2, "0")}-${String(lastDateObj.getUTCDate()).padStart(2, "0")}T23:59:59Z`;

const monthMap = new Map(months.map((m) => [m.key, m]));

async function githubGet(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "azizullahaziz-pr-review-chart",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${text}`);
  }
  return response.json();
}

async function graphql(query, variables = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `token ${githubToken}`,
      "Content-Type": "application/json",
      "User-Agent": "azizullahaziz-pr-review-chart",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GraphQL HTTP error ${response.status}: ${text}`);
  }
  const result = await response.json();
  if (result.errors && result.errors.length > 0) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }
  if (!result.data) {
    throw new Error(`GraphQL response missing data: ${JSON.stringify(result)}`);
  }
  return result.data;
}

async function searchAllPages(queryString) {
  const items = [];
  let page = 1;
  while (true) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(queryString)}&per_page=100&page=${page}`;
    const data = await githubGet(url);
    if (!data || !Array.isArray(data.items)) {
      throw new Error(`Malformed search response: ${JSON.stringify(data)}`);
    }
    items.push(...data.items);
    if (items.length >= data.total_count || data.items.length < 100) break;
    page++;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return items;
}

// ─── Fetch PRs authored by user ──────────────────────────────────────────────

async function fetchPullRequests() {
  const rangeStartDate = rangeStart.slice(0, 10);
  const rangeEndDate = rangeEnd.slice(0, 10);
  const query = `type:pr author:${githubLogin} created:${rangeStartDate}..${rangeEndDate}`;
  const items = await searchAllPages(query);
  for (const item of items) {
    const key = item.created_at.slice(0, 7); // "YYYY-MM"
    const month = monthMap.get(key);
    if (month) month.pullRequests++;
  }
  console.log(`[PRs] Fetched ${items.length} PRs authored by ${githubLogin} in range ${rangeStartDate}..${rangeEndDate}`);
  const perMonth = months.map((m) => `${m.key}:${m.pullRequests}`).join(" ");
  console.log(`[PRs] Per-month: ${perMonth}`);
}

// ─── Fetch reviews via GraphQL contributionsCollection ───────────────────────
//
// Strategy: Use GraphQL pullRequestReviewContributions with pagination to get
// the reviews submitted by the user within each year covered by our 12-month
// range. This field gives one entry per (PR, review-state) pair authored by
// the user, which is the most accurate representation available via the public
// API. We count each contribution record per month of its occurredAt timestamp.
//
// Limitation: The GitHub GraphQL contributionsCollection is scoped to a single
// calendar year (Jan 1 – Dec 31 UTC). For ranges spanning two years we query
// both years. Each contribution record corresponds to the most-recent review
// state the user submitted on a given PR (not every individual review comment).
// Therefore this count reflects "PRs where the user submitted a review" per
// month, not raw review-submission events. This is the best granularity the
// public GitHub API provides without read access to private repositories.

async function fetchReviewsViaGraphQL() {
  const startYear = parseInt(rangeStart.slice(0, 4), 10);
  const endYear = parseInt(rangeEnd.slice(0, 4), 10);
  const years = [];
  for (let y = startYear; y <= endYear; y++) years.push(y);

  let totalContributions = 0;

  for (const year of years) {
    const from = `${year}-01-01T00:00:00Z`;
    const to = `${year}-12-31T23:59:59Z`;

    let cursor = null;
    let pageCount = 0;

    while (true) {
      const data = await graphql(`
        query($login: String!, $from: DateTime!, $to: DateTime!, $after: String) {
          user(login: $login) {
            contributionsCollection(from: $from, to: $to) {
              pullRequestReviewContributions(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  occurredAt
                  pullRequest {
                    number
                    repository { nameWithOwner }
                  }
                }
              }
            }
          }
        }
      `, { login: githubLogin, from, to, after: cursor });

      if (!data.user) {
        throw new Error(`GraphQL: user '${githubLogin}' not found or not accessible`);
      }

      const reviewContribs = data.user.contributionsCollection.pullRequestReviewContributions;
      if (!reviewContribs || !Array.isArray(reviewContribs.nodes)) {
        throw new Error(`GraphQL: pullRequestReviewContributions missing nodes for year ${year}`);
      }

      for (const node of reviewContribs.nodes) {
        const key = node.occurredAt.slice(0, 7);
        const month = monthMap.get(key);
        if (month) {
          month.reviews++;
          totalContributions++;
        }
      }

      pageCount++;
      if (!reviewContribs.pageInfo.hasNextPage) break;
      cursor = reviewContribs.pageInfo.endCursor;
      await new Promise((r) => setTimeout(r, 300));
    }

    console.log(`[Reviews] Year ${year}: processed ${pageCount} page(s) of review contributions`);
  }

  console.log(`[Reviews] Total review contributions counted in range: ${totalContributions}`);
  const perMonth = months.map((m) => `${m.key}:${m.reviews}`).join(" ");
  console.log(`[Reviews] Per-month: ${perMonth}`);
}

// ─── SVG generation ──────────────────────────────────────────────────────────

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function generateChart(months) {
  const width = 920;
  const height = 440;
  const padding = { top: 82, right: 45, bottom: 92, left: 65 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxValue = Math.max(
    1,
    ...months.flatMap((m) => [m.pullRequests, m.reviews])
  );

  const x = (i) =>
    months.length === 1
      ? padding.left + chartWidth / 2
      : padding.left + (i * chartWidth) / (months.length - 1);

  const y = (v) =>
    padding.top + chartHeight - (v / maxValue) * chartHeight;

  const linePath = (prop) =>
    months
      .map((m, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(m[prop])}`)
      .join(" ");

  const totalPRs = months.reduce((s, m) => s + m.pullRequests, 0);
  const totalReviews = months.reduce((s, m) => s + m.reviews, 0);

  const gridLines = Array.from({ length: 5 }, (_, i) => {
    const value = Math.round((maxValue * i) / 4);
    const lineY = y(value);
    return `
      <line x1="${padding.left}" y1="${lineY}" x2="${width - padding.right}" y2="${lineY}" stroke="#26334D" stroke-width="1"/>
      <text x="${padding.left - 12}" y="${lineY + 5}" text-anchor="end" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="12">${value}</text>`;
  }).join("");

  const monthLabels = months
    .map(
      (m, i) =>
        `<text x="${x(i)}" y="${height - 48}" text-anchor="middle" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="12">${escapeXml(m.label)}</text>`
    )
    .join("");

  const points = (prop, color) =>
    months
      .map(
        (m, i) =>
          `<circle cx="${x(i)}" cy="${y(m[prop])}" r="4" fill="${color}" stroke="#101827" stroke-width="2"/>`
      )
      .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="prc-title prc-desc">
  <title id="prc-title">Pull Requests Opened and Code Reviews Completed</title>
  <desc id="prc-desc">Monthly pull requests opened and pull-request reviews completed for ${escapeXml(githubLogin)} during the last twelve months.</desc>
  <defs>
    <linearGradient id="prc-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#101827"/>
      <stop offset="100%" stop-color="#16243D"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="18" fill="url(#prc-bg)"/>
  <text x="${padding.left}" y="34" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="21" font-weight="700">Pull Requests &amp; Code Reviews</text>
  <text x="${padding.left}" y="57" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="12">Monthly engineering collaboration · Last 12 months · ${escapeXml(githubLogin)}</text>
  <line x1="${width - 300}" y1="30" x2="${width - 275}" y2="30" stroke="#00D4FF" stroke-width="3"/>
  <text x="${width - 265}" y="34" fill="#C9D5E8" font-family="Arial, sans-serif" font-size="12">PRs opened (${totalPRs})</text>
  <line x1="${width - 300}" y1="53" x2="${width - 275}" y2="53" stroke="#9B7CFF" stroke-width="3"/>
  <text x="${width - 265}" y="57" fill="#C9D5E8" font-family="Arial, sans-serif" font-size="12">Reviews completed (${totalReviews})</text>
  ${gridLines}
  <path d="${linePath("pullRequests")}" fill="none" stroke="#00D4FF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${linePath("reviews")}" fill="none" stroke="#9B7CFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  ${points("pullRequests", "#00D4FF")}
  ${points("reviews", "#9B7CFF")}
  ${monthLabels}
  <text x="${width / 2}" y="${height - 15}" text-anchor="middle" fill="#64748B" font-family="Arial, sans-serif" font-size="11">Month</text>
</svg>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Generating PR/review chart for ${githubLogin}`);
  console.log(`Range: ${rangeStart.slice(0, 10)} → ${rangeEnd.slice(0, 10)}`);

  await fetchPullRequests();
  await fetchReviewsViaGraphQL();

  console.log("[Summary] Monthly totals:");
  for (const m of months) {
    console.log(`  ${m.key}: PRs=${m.pullRequests} Reviews=${m.reviews}`);
  }

  const outputPath = path.join(process.cwd(), "assets", "pr-review-chart.svg");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generateChart(months) + "\n", "utf8");
  console.log(`Chart generated: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
