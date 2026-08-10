import fs from "node:fs";
import path from "node:path";

const githubLogin = process.env.GITHUB_LOGIN || "azizullahaziz";
const githubToken = process.env.GITHUB_TOKEN;

if (!githubToken) {
  throw new Error("GITHUB_TOKEN is required.");
}

const now = new Date();

const from = new Date(
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1)
);

const to = new Date(
  Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    0,
    23,
    59,
    59,
    999
  )
);

const graphqlQuery = `
  query (
    $login: String!,
    $from: DateTime!,
    $to: DateTime!,
    $pullRequestCursor: String,
    $reviewCursor: String
  ) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        pullRequestContributions(
          first: 100
          after: $pullRequestCursor
        ) {
          nodes {
            occurredAt
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }

        pullRequestReviewContributions(
          first: 100
          after: $reviewCursor
        ) {
          nodes {
            occurredAt
          }
          pageInfo {
            hasNextPage
            endCursor
          }
        }
      }
    }
  }
`;

async function fetchContributions() {
  const pullRequests = [];
  const reviews = [];

  let pullRequestCursor = null;
  let reviewCursor = null;
  let pullRequestsComplete = false;
  let reviewsComplete = false;

  while (!pullRequestsComplete || !reviewsComplete) {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${githubToken}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "User-Agent": "azizullahaziz-pr-review-chart"
      },
      body: JSON.stringify({
        query: graphqlQuery,
        variables: {
          login: githubLogin,
          from: from.toISOString(),
          to: to.toISOString(),
          pullRequestCursor,
          reviewCursor
        }
      })
    });

    const result = await response.json();

    if (!response.ok || result.errors) {
      console.error(JSON.stringify(result, null, 2));
      throw new Error("GitHub GraphQL request failed.");
    }

    const contributions = result.data.user.contributionsCollection;

    if (!pullRequestsComplete) {
      const connection = contributions.pullRequestContributions;

      pullRequests.push(...connection.nodes);

      pullRequestsComplete = !connection.pageInfo.hasNextPage;
      pullRequestCursor = connection.pageInfo.endCursor;
    }

    if (!reviewsComplete) {
      const connection = contributions.pullRequestReviewContributions;

      reviews.push(...connection.nodes);

      reviewsComplete = !connection.pageInfo.hasNextPage;
      reviewCursor = connection.pageInfo.endCursor;
    }
  }

  return {
    pullRequests,
    reviews
  };
}

function createMonths() {
  const months = [];

  for (let index = 11; index >= 0; index--) {
    const date = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1)
    );

    months.push({
      key: `${date.getUTCFullYear()}-${String(
        date.getUTCMonth() + 1
      ).padStart(2, "0")}`,
      label: date.toLocaleString("en-US", {
        month: "short",
        timeZone: "UTC"
      }),
      pullRequests: 0,
      reviews: 0
    });
  }

  return months;
}

function addContribution(monthMap, occurredAt, property) {
  const date = new Date(occurredAt);

  const key = `${date.getUTCFullYear()}-${String(
    date.getUTCMonth() + 1
  ).padStart(2, "0")}`;

  const month = monthMap.get(key);

  if (month) {
    month[property] += 1;
  }
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

  const padding = {
    top: 82,
    right: 45,
    bottom: 92,
    left: 65
  };

  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const maxValue = Math.max(
    1,
    ...months.flatMap((month) => [
      month.pullRequests,
      month.reviews
    ])
  );

  const x = (index) => {
    if (months.length === 1) {
      return padding.left + chartWidth / 2;
    }

    return padding.left + (index * chartWidth) / (months.length - 1);
  };

  const y = (value) =>
    padding.top + chartHeight - (value / maxValue) * chartHeight;

  const linePath = (property) =>
    months
      .map(
        (month, index) =>
          `${index === 0 ? "M" : "L"} ${x(index)} ${y(
            month[property]
          )}`
      )
      .join(" ");

  const totalPullRequests = months.reduce(
    (total, month) => total + month.pullRequests,
    0
  );

  const totalReviews = months.reduce(
    (total, month) => total + month.reviews,
    0
  );

  const gridLines = Array.from({ length: 5 }, (_, index) => {
    const value = Math.round((maxValue * index) / 4);
    const lineY = y(value);

    return `
      <line
        x1="${padding.left}"
        y1="${lineY}"
        x2="${width - padding.right}"
        y2="${lineY}"
        stroke="#26334D"
        stroke-width="1"
      />

      <text
        x="${padding.left - 12}"
        y="${lineY + 5}"
        text-anchor="end"
        fill="#8B9BB4"
        font-family="Arial, sans-serif"
        font-size="12"
      >${value}</text>
    `;
  }).join("");

  const monthLabels = months
    .map(
      (month, index) => `
        <text
          x="${x(index)}"
          y="${height - 48}"
          text-anchor="middle"
          fill="#8B9BB4"
          font-family="Arial, sans-serif"
          font-size="12"
        >${escapeXml(month.label)}</text>
      `
    )
    .join("");

  const chartPoints = (property, color) =>
    months
      .map(
        (month, index) => `
          <circle
            cx="${x(index)}"
            cy="${y(month[property])}"
            r="4"
            fill="${color}"
            stroke="#101827"
            stroke-width="2"
          />
        `
      )
      .join("");

  return `
<svg
  xmlns="http://www.w3.org/2000/svg"
  width="${width}"
  height="${height}"
  viewBox="0 0 ${width} ${height}"
  role="img"
  aria-labelledby="title description"
>
  <title id="title">
    Pull Requests Opened and Code Reviews Completed
  </title>

  <desc id="description">
    Monthly pull requests opened and pull-request reviews completed for ${escapeXml(
      githubLogin
    )} during the last twelve months.
  </desc>

  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#101827" />
      <stop offset="100%" stop-color="#16243D" />
    </linearGradient>
  </defs>

  <rect
    width="100%"
    height="100%"
    rx="18"
    fill="url(#background)"
  />

  <text
    x="${padding.left}"
    y="34"
    fill="#FFFFFF"
    font-family="Arial, sans-serif"
    font-size="21"
    font-weight="700"
  >
    Pull Requests &amp; Code Reviews
  </text>

  <text
    x="${padding.left}"
    y="57"
    fill="#8B9BB4"
    font-family="Arial, sans-serif"
    font-size="12"
  >
    Monthly engineering collaboration · Last 12 months · ${escapeXml(
      githubLogin
    )}
  </text>

  <line
    x1="${width - 300}"
    y1="30"
    x2="${width - 275}"
    y2="30"
    stroke="#00D4FF"
    stroke-width="3"
  />

  <text
    x="${width - 265}"
    y="34"
    fill="#C9D5E8"
    font-family="Arial, sans-serif"
    font-size="12"
  >
    PRs opened (${totalPullRequests})
  </text>

  <line
    x1="${width - 300}"
    y1="53"
    x2="${width - 275}"
    y2="53"
    stroke="#9B7CFF"
    stroke-width="3"
  />

  <text
    x="${width - 265}"
    y="57"
    fill="#C9D5E8"
    font-family="Arial, sans-serif"
    font-size="12"
  >
    Reviews completed (${totalReviews})
  </text>

  ${gridLines}

  <path
    d="${linePath("pullRequests")}"
    fill="none"
    stroke="#00D4FF"
    stroke-width="3"
    stroke-linecap="round"
    stroke-linejoin="round"
  />

  <path
    d="${linePath("reviews")}"
    fill="none"
    stroke="#9B7CFF"
    stroke-width="3"
    stroke-linecap="round"
    stroke-linejoin="round"
  />

  ${chartPoints("pullRequests", "#00D4FF")}
  ${chartPoints("reviews", "#9B7CFF")}

  ${monthLabels}

  <text
    x="${width / 2}"
    y="${height - 15}"
    text-anchor="middle"
    fill="#64748B"
    font-family="Arial, sans-serif"
    font-size="11"
  >
    Month
  </text>
</svg>
`.trim();
}

async function main() {
  const { pullRequests, reviews } = await fetchContributions();

  const months = createMonths();
  const monthMap = new Map(months.map((month) => [month.key, month]));

  for (const contribution of pullRequests) {
    addContribution(monthMap, contribution.occurredAt, "pullRequests");
  }

  for (const contribution of reviews) {
    addContribution(monthMap, contribution.occurredAt, "reviews");
  }

  const outputPath = path.join(
    process.cwd(),
    "assets",
    "pr-review-chart.svg"
  );

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${generateChart(months)}\n`, "utf8");

  console.log(`Chart generated successfully: ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
