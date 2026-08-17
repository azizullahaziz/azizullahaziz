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
const rangeStart = `${firstMonth.year}-${firstMonth.key.slice(5)}-01`;
const lastDate = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)
);
const rangeEnd = `${lastDate.getUTCFullYear()}-${String(lastDate.getUTCMonth() + 1).padStart(2, "0")}-${String(lastDate.getUTCDate()).padStart(2, "0")}`;

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

async function searchAllPages(queryString) {
  const items = [];
  let page = 1;
  while (true) {
    const url = `https://api.github.com/search/issues?q=${encodeURIComponent(queryString)}&per_page=100&page=${page}`;
    const data = await githubGet(url);
    items.push(...data.items);
    if (items.length >= data.total_count || data.items.length < 100) break;
    page++;
    // Respect secondary rate limit
    await new Promise((r) => setTimeout(r, 1000));
  }
  return items;
}

async function fetchPullRequests() {
  const query = `type:pr author:${githubLogin} created:${rangeStart}..${rangeEnd}`;
  const items = await searchAllPages(query);
  for (const item of items) {
    const key = item.created_at.slice(0, 7); // "YYYY-MM"
    const month = monthMap.get(key);
    if (month) month.pullRequests++;
  }
  console.log(`Fetched ${items.length} PRs authored by ${githubLogin}`);
}

async function fetchReviews() {
  // Search for PRs that the user reviewed in the range
  const query = `type:pr reviewed-by:${githubLogin} updated:${rangeStart}..${rangeEnd}`;
  const prs = await searchAllPages(query);
  console.log(`Found ${prs.length} PRs reviewed by ${githubLogin}, fetching individual reviews...`);

  for (const pr of prs) {
    // Extract owner/repo/number from pull_request.url
    // item.pull_request.url: https://api.github.com/repos/owner/repo/pulls/number
    const prUrl = item_to_reviews_url(pr);
    let page = 1;
    while (true) {
      const reviews = await githubGet(`${prUrl}?per_page=100&page=${page}`);
      for (const review of reviews) {
        if (
          review.user &&
          review.user.login.toLowerCase() === githubLogin.toLowerCase() &&
          review.submitted_at
        ) {
          const key = review.submitted_at.slice(0, 7);
          const month = monthMap.get(key);
          if (month) month.reviews++;
        }
      }
      if (reviews.length < 100) break;
      page++;
      await new Promise((r) => setTimeout(r, 200));
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

function item_to_reviews_url(pr) {
  // pr.pull_request.url is like https://api.github.com/repos/owner/repo/pulls/123
  // We need https://api.github.com/repos/owner/repo/pulls/123/reviews
  const base = pr.pull_request
    ? pr.pull_request.url
    : pr.url.replace("/issues/", "/pulls/");
  return `${base}/reviews`;
}

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

async function main() {
  await fetchPullRequests();
  await fetchReviews();

  const outputPath = path.join(process.cwd(), "assets", "pr-review-chart.svg");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generateChart(months) + "\n", "utf8");
  console.log(`Chart generated: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
