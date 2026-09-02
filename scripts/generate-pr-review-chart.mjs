import fs from "node:fs";
import path from "node:path";
import {
  createGitHubClient,
  createMonthBuckets,
  discoverRepositories,
  escapeXml,
  getConfiguredLogin,
  getGitHubToken,
  isWithinRange,
  sleep,
  toMonthKey,
} from "./github-analytics-common.mjs";

const configuredLogin = getConfiguredLogin();
const githubToken = getGitHubToken();

const { months, start: rangeStart, endExclusive: rangeEndExclusive } = createMonthBuckets(12);
const monthMap = new Map(months.map((m) => [m.key, m]));

const client = createGitHubClient({
  token: githubToken,
  userAgent: "azizullahaziz-pr-review-chart",
});

function formatDateOnly(date) {
  return date.toISOString().slice(0, 10);
}

function incrementMonth(dateString, key) {
  if (!isWithinRange(dateString, rangeStart, rangeEndExclusive)) return false;
  const month = monthMap.get(toMonthKey(dateString));
  if (!month) return false;
  month[key] += 1;
  return true;
}

async function searchRepoPRs(query) {
  let page = 1;
  const items = [];
  while (true) {
    const encoded = encodeURIComponent(query);
    const url = `https://api.github.com/search/issues?q=${encoded}&per_page=100&page=${page}`;
    const { data } = await client.request(url);
    if (!data || !Array.isArray(data.items)) {
      throw new Error(`Malformed search response for query: ${query}`);
    }
    items.push(...data.items);
    if (data.items.length < 100 || page >= 10) break;
    page += 1;
    await sleep(250);
  }
  return items;
}

async function fetchReviewsForPullRequest(owner, repo, number) {
  const reviews = [];
  let page = 1;
  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${number}/reviews?per_page=100&page=${page}`;
    const data = await client.githubGet(url);
    if (!Array.isArray(data)) {
      throw new Error(`Malformed reviews response for ${owner}/${repo}#${number}`);
    }
    reviews.push(...data);
    if (data.length < 100) break;
    page += 1;
    await sleep(200);
  }
  return reviews;
}

async function fetchPullRequestsAndReviews(discovery) {
  const canonicalLogin = discovery.login;
  const loginAliases = new Set([configuredLogin.toLowerCase(), canonicalLogin.toLowerCase()]);
  const rangeStartDate = formatDateOnly(rangeStart);
  const rangeEndDate = formatDateOnly(new Date(rangeEndExclusive.getTime() - 1000));

  const diagnostics = {
    authoredPullRequests: 0,
    reviewedPullRequestCandidates: 0,
    submittedReviews: 0,
    skippedRepositories: [],
    inaccessibleRepositories: new Set(),
  };

  try {
    const fetchContributions = async (connectionName, monthKey) => {
      let after = null;
      while (true) {
        const data = await client.graphql(
          `query($login: String!, $from: DateTime!, $to: DateTime!, $after: String) {
            user(login: $login) {
              contributionsCollection(from: $from, to: $to) {
                ${connectionName}(first: 100, after: $after) {
                  pageInfo { hasNextPage endCursor }
                  nodes { occurredAt }
                }
              }
            }
          }`,
          {
            login: canonicalLogin,
            from: rangeStart.toISOString(),
            to: rangeEndExclusive.toISOString(),
            after,
          }
        );
        const connection = data.user?.contributionsCollection?.[connectionName];
        if (!connection || !Array.isArray(connection.nodes)) {
          throw new Error(`Malformed ${connectionName} response`);
        }
        for (const contribution of connection.nodes) {
          if (incrementMonth(contribution.occurredAt, monthKey)) {
            diagnostics[monthKey === "pullRequests" ? "authoredPullRequests" : "submittedReviews"] += 1;
          }
        }
        if (!connection.pageInfo?.hasNextPage) break;
        after = connection.pageInfo.endCursor;
        await sleep(150);
      }
    };

    await fetchContributions("pullRequestContributions", "pullRequests");
    await fetchContributions("pullRequestReviewContributions", "reviews");
    diagnostics.activitySource = "GraphQL contributions";
    return diagnostics;
  } catch (error) {
    diagnostics.activitySource = "repository search fallback";
    diagnostics.skippedRepositories.push(`GraphQL contribution activity failed (${error.message})`);
  }

  for (const repository of discovery.repositories) {
    const { owner, name, nameWithOwner } = repository;

    try {
      const authoredQuery = `type:pr repo:${nameWithOwner} author:${canonicalLogin} created:${rangeStartDate}..${rangeEndDate}`;
      const authored = await searchRepoPRs(authoredQuery);
      for (const item of authored) {
        if (incrementMonth(item.created_at, "pullRequests")) diagnostics.authoredPullRequests += 1;
      }
    } catch (error) {
      diagnostics.skippedRepositories.push(`${nameWithOwner}: authored PR search failed (${error.message})`);
      diagnostics.inaccessibleRepositories.add(nameWithOwner);
      continue;
    }

    try {
      const reviewedQuery = `type:pr repo:${nameWithOwner} reviewed-by:${canonicalLogin} updated:${rangeStartDate}..${rangeEndDate}`;
      const candidates = await searchRepoPRs(reviewedQuery);
      diagnostics.reviewedPullRequestCandidates += candidates.length;

      const seenPullNumbers = new Set();
      for (const item of candidates) {
        const prNumber = item?.number;
        if (!prNumber || seenPullNumbers.has(prNumber)) continue;
        seenPullNumbers.add(prNumber);

        const reviews = await fetchReviewsForPullRequest(owner, name, prNumber);
        for (const review of reviews) {
          const submittedAt = review?.submitted_at;
          const reviewer = review?.user?.login?.toLowerCase();
          if (!submittedAt || !reviewer || !loginAliases.has(reviewer)) continue;
          if (incrementMonth(submittedAt, "reviews")) diagnostics.submittedReviews += 1;
        }
      }
    } catch (error) {
      diagnostics.skippedRepositories.push(`${nameWithOwner}: review scan failed (${error.message})`);
      diagnostics.inaccessibleRepositories.add(nameWithOwner);
    }

    await sleep(120);
  }

  return diagnostics;
}

function generateChart(months, discovery, diagnostics) {
  const width = 920;
  const height = 500;
  const padding = { top: 90, right: 45, bottom: 120, left: 65 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxValue = Math.max(1, ...months.flatMap((m) => [m.pullRequests, m.reviews]));
  const x = (i) => (months.length === 1 ? padding.left + chartWidth / 2 : padding.left + (i * chartWidth) / (months.length - 1));
  const y = (v) => padding.top + chartHeight - (v / maxValue) * chartHeight;

  const linePath = (prop) => months.map((m, i) => `${i === 0 ? "M" : "L"} ${x(i)} ${y(m[prop])}`).join(" ");

  const totalPRs = months.reduce((s, m) => s + m.pullRequests, 0);
  const totalReviews = months.reduce((s, m) => s + m.reviews, 0);
  const inaccessibleCount = diagnostics.inaccessibleRepositories.size;

  const scopeSubtitle = `Accessible/discoverable repositories (owned, contributed, org, PR/review-linked); private org data requires token + SSO permission.`;
  const diagSubtitle = `Repos discovered: ${discovery.diagnostics.discoveredRepositoryCount} (public ${discovery.diagnostics.publicRepositoryCount}, private ${discovery.diagnostics.privateRepositoryCount}, inaccessible ${inaccessibleCount}) · PRs ${diagnostics.authoredPullRequests} · Review candidates ${diagnostics.reviewedPullRequestCandidates} · Submitted reviews ${diagnostics.submittedReviews}`;

  const warnings = [
    ...discovery.diagnostics.sourceFailures,
    ...discovery.diagnostics.warnings,
    ...diagnostics.skippedRepositories,
  ];

  const warningText = warnings.length > 0
    ? `Diagnostics: ${warnings.slice(0, 2).join(" | ")}${warnings.length > 2 ? ` | +${warnings.length - 2} more` : ""}`
    : totalPRs === 0 && totalReviews === 0
      ? "Diagnostics: No PR/review activity found in accessible repositories for this UTC range."
      : "Diagnostics: Repository scan completed without access errors.";

  const gridLines = Array.from({ length: 5 }, (_, i) => {
    const value = Math.round((maxValue * i) / 4);
    const lineY = y(value);
    return `
      <line x1="${padding.left}" y1="${lineY}" x2="${width - padding.right}" y2="${lineY}" stroke="#26334D" stroke-width="1"/>
      <text x="${padding.left - 12}" y="${lineY + 5}" text-anchor="end" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="12">${value}</text>`;
  }).join("");

  const monthLabels = months
    .map((m, i) => `<text x="${x(i)}" y="${height - 74}" text-anchor="middle" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="12">${escapeXml(m.label)}</text>`)
    .join("");

  const points = (prop, color) =>
    months
      .map((m, i) => `<circle cx="${x(i)}" cy="${y(m[prop])}" r="4" fill="${color}" stroke="#101827" stroke-width="2"/>`)
      .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="prc-title prc-desc">
  <title id="prc-title">Pull Requests Opened and Code Reviews Completed</title>
  <desc id="prc-desc">Monthly pull requests opened and individual pull-request reviews submitted by ${escapeXml(discovery.login)} across accessible and discoverable repositories over the last twelve months.</desc>
  <defs>
    <linearGradient id="prc-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#101827"/>
      <stop offset="100%" stop-color="#16243D"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="18" fill="url(#prc-bg)"/>
  <text x="${padding.left}" y="34" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="21" font-weight="700">Pull Requests Opened &amp; Code Reviews Completed</text>
  <text x="${padding.left}" y="55" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="11">${escapeXml(scopeSubtitle)}</text>
  <text x="${padding.left}" y="72" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="11">${escapeXml(diagSubtitle)}</text>
  <line x1="${width - 300}" y1="30" x2="${width - 275}" y2="30" stroke="#00D4FF" stroke-width="3"/>
  <text x="${width - 265}" y="34" fill="#C9D5E8" font-family="Arial, sans-serif" font-size="12">PRs opened (${totalPRs})</text>
  <line x1="${width - 300}" y1="53" x2="${width - 275}" y2="53" stroke="#9B7CFF" stroke-width="3"/>
  <text x="${width - 265}" y="57" fill="#C9D5E8" font-family="Arial, sans-serif" font-size="12">Reviews submitted (${totalReviews})</text>
  ${gridLines}
  <path d="${linePath("pullRequests")}" fill="none" stroke="#00D4FF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${linePath("reviews")}" fill="none" stroke="#9B7CFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  ${points("pullRequests", "#00D4FF")}
  ${points("reviews", "#9B7CFF")}
  ${monthLabels}
  <text x="${width / 2}" y="${height - 41}" text-anchor="middle" fill="#64748B" font-family="Arial, sans-serif" font-size="11">Month (UTC)</text>
  <text x="${width / 2}" y="${height - 20}" text-anchor="middle" fill="#64748B" font-family="Arial, sans-serif" font-size="10">${escapeXml(warningText)}</text>
</svg>`;
}

async function main() {
  console.log(`Generating PR/review chart for ${configuredLogin}`);
  console.log(`Range (UTC): ${formatDateOnly(rangeStart)} → ${formatDateOnly(new Date(rangeEndExclusive.getTime() - 1000))}`);

  const discovery = await discoverRepositories({ client, login: configuredLogin });
  console.log(`[Discovery] Repositories=${discovery.diagnostics.discoveredRepositoryCount} public=${discovery.diagnostics.publicRepositoryCount} private=${discovery.diagnostics.privateRepositoryCount}`);
  if (discovery.diagnostics.sourceFailures.length > 0) {
    console.log(`[Discovery] Source failures: ${discovery.diagnostics.sourceFailures.join(" | ")}`);
  }
  if (discovery.diagnostics.warnings.length > 0) {
    console.log(`[Discovery] Warnings: ${discovery.diagnostics.warnings.join(" | ")}`);
  }

  const diagnostics = await fetchPullRequestsAndReviews(discovery);
  console.log(`[Counts] Authored PRs=${diagnostics.authoredPullRequests}`);
  console.log(`[Counts] Reviewed PR candidates=${diagnostics.reviewedPullRequestCandidates}`);
  console.log(`[Counts] Submitted reviews=${diagnostics.submittedReviews}`);
  console.log(`[Counts] Inaccessible/skipped repositories=${diagnostics.inaccessibleRepositories.size}`);
  if (diagnostics.skippedRepositories.length > 0) {
    console.log(`[Counts] Skipped detail: ${diagnostics.skippedRepositories.slice(0, 5).join(" | ")}${diagnostics.skippedRepositories.length > 5 ? ` | +${diagnostics.skippedRepositories.length - 5} more` : ""}`);
  }

  console.log("[Summary] Per-month totals:");
  for (const m of months) {
    console.log(`  ${m.key}: PRs=${m.pullRequests} Reviews=${m.reviews}`);
  }

  const outputPath = path.join(process.cwd(), "assets", "pr-review-chart.svg");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, generateChart(months, discovery, diagnostics) + "\n", "utf8");
  console.log(`Chart generated: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
