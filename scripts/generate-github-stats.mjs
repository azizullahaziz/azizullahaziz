import fs from "node:fs";
import path from "node:path";

const githubLogin = process.env.GITHUB_LOGIN || "azizullahaziz";
const githubToken = process.env.GITHUB_TOKEN;

if (!githubToken) {
  throw new Error("GITHUB_TOKEN is required.");
}

async function githubGet(url) {
  const response = await fetch(url, {
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "azizullahaziz-github-stats",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub API error ${response.status} for ${url}: ${text}`);
  }
  return response.json();
}

async function graphql(query, variables = {}) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `token ${githubToken}`,
      "Content-Type": "application/json",
      "User-Agent": "azizullahaziz-github-stats",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GraphQL error ${response.status}: ${text}`);
  }
  const result = await response.json();
  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }
  return result.data;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

// ─── Fetch user profile ───────────────────────────────────────────────────────

async function fetchUser() {
  const data = await githubGet(
    `https://api.github.com/users/${githubLogin}`
  );
  return {
    publicRepos: data.public_repos,
    followers: data.followers,
    following: data.following,
  };
}

// ─── Fetch all non-forked repos ───────────────────────────────────────────────

async function fetchRepos() {
  const repos = [];
  let page = 1;
  while (true) {
    const data = await githubGet(
      `https://api.github.com/users/${githubLogin}/repos?per_page=100&page=${page}&type=owner`
    );
    repos.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return repos;
}

// ─── Contribution calendar via GraphQL ───────────────────────────────────────

async function fetchContributionCalendar() {
  const data = await graphql(`
    query($login: String!) {
      user(login: $login) {
        contributionsCollection {
          contributionCalendar {
            totalContributions
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }
      }
    }
  `, { login: githubLogin });

  return data.user.contributionsCollection.contributionCalendar;
}

// ─── Streak calculation ───────────────────────────────────────────────────────

function calculateStreaks(calendar) {
  const days = calendar.weeks
    .flatMap((w) => w.contributionDays)
    .sort((a, b) => a.date.localeCompare(b.date));

  let currentStreak = 0;
  let longestStreak = 0;
  let streak = 0;
  const today = new Date().toISOString().slice(0, 10);

  // Walk backwards from today to find current streak
  let i = days.length - 1;
  // skip today if no contributions yet (still in progress)
  if (days[i] && days[i].date === today && days[i].contributionCount === 0) {
    i--;
  }
  while (i >= 0 && days[i].contributionCount > 0) {
    currentStreak++;
    i--;
  }

  // Find longest streak
  streak = 0;
  for (const day of days) {
    if (day.contributionCount > 0) {
      streak++;
      if (streak > longestStreak) longestStreak = streak;
    } else {
      streak = 0;
    }
  }

  return { currentStreak, longestStreak };
}

// ─── Language aggregation ─────────────────────────────────────────────────────

async function fetchLanguages(repos) {
  const langBytes = new Map();
  const ownRepos = repos.filter((r) => !r.fork);

  for (const repo of ownRepos) {
    if (repo.size === 0) continue;
    try {
      const langs = await githubGet(
        `https://api.github.com/repos/${repo.full_name}/languages`
      );
      for (const [lang, bytes] of Object.entries(langs)) {
        langBytes.set(lang, (langBytes.get(lang) || 0) + bytes);
      }
    } catch {
      // skip repos that return errors
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  const total = Array.from(langBytes.values()).reduce((s, v) => s + v, 0);
  const sorted = Array.from(langBytes.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([lang, bytes]) => ({ lang, bytes, pct: total > 0 ? bytes / total : 0 }));

  return { langs: sorted, total };
}

// ─── SVG generators ──────────────────────────────────────────────────────────

const LANG_COLORS = {
  PHP: "#4F5D95",
  JavaScript: "#F1E05A",
  TypeScript: "#3178C6",
  Java: "#B07219",
  Dart: "#00B4AB",
  HTML: "#E34C26",
  CSS: "#563D7C",
  Shell: "#89E051",
  Python: "#3572A5",
  Go: "#00ADD8",
  Ruby: "#701516",
  "C#": "#239120",
  "C++": "#F34B7D",
  Vue: "#41B883",
  Kotlin: "#A97BFF",
  Swift: "#FA7343",
  Blade: "#F7523F",
};

function langColor(name) {
  return LANG_COLORS[name] || "#8B9BB4";
}

function generateOverviewSvg({ publicRepos, followers, following, totalStars, totalContributions }) {
  const width = 495;
  const height = 195;
  const stats = [
    { label: "Public Repos", value: publicRepos },
    { label: "Stars Earned", value: totalStars },
    { label: "Contributions", value: totalContributions },
    { label: "Followers", value: followers },
    { label: "Following", value: following },
  ];

  const rows = stats
    .map(
      (s, i) => `
    <text x="30" y="${78 + i * 22}" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="13">${escapeXml(s.label)}</text>
    <text x="${width - 30}" y="${78 + i * 22}" text-anchor="end" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="13" font-weight="600">${escapeXml(String(s.value))}</text>`
    )
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="ov-title">
  <title id="ov-title">GitHub Overview for ${escapeXml(githubLogin)}</title>
  <defs>
    <linearGradient id="ov-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#101827"/>
      <stop offset="100%" stop-color="#16243D"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="10" fill="url(#ov-bg)"/>
  <text x="30" y="40" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="17" font-weight="700">📊 GitHub Overview</text>
  <text x="30" y="58" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="11">${escapeXml(githubLogin)}</text>
  <line x1="30" y1="66" x2="${width - 30}" y2="66" stroke="#26334D" stroke-width="1"/>
  ${rows}
</svg>`;
}

function generateStreakSvg({ currentStreak, longestStreak, totalContributions }) {
  const width = 495;
  const height = 195;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="sk-title">
  <title id="sk-title">GitHub Contribution Streak for ${escapeXml(githubLogin)}</title>
  <defs>
    <linearGradient id="sk-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#101827"/>
      <stop offset="100%" stop-color="#16243D"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="10" fill="url(#sk-bg)"/>
  <text x="${width / 2}" y="36" text-anchor="middle" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="17" font-weight="700">🔥 Contribution Streak</text>
  <text x="${width / 2}" y="54" text-anchor="middle" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="11">${escapeXml(githubLogin)}</text>

  <!-- Current streak -->
  <text x="${width / 4}" y="105" text-anchor="middle" fill="#00D4FF" font-family="Arial, sans-serif" font-size="42" font-weight="700">${currentStreak}</text>
  <text x="${width / 4}" y="128" text-anchor="middle" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="12">Current Streak</text>
  <text x="${width / 4}" y="145" text-anchor="middle" fill="#64748B" font-family="Arial, sans-serif" font-size="11">days</text>

  <!-- Divider -->
  <line x1="${width / 2}" y1="75" x2="${width / 2}" y2="155" stroke="#26334D" stroke-width="1"/>

  <!-- Longest streak -->
  <text x="${(3 * width) / 4}" y="105" text-anchor="middle" fill="#9B7CFF" font-family="Arial, sans-serif" font-size="42" font-weight="700">${longestStreak}</text>
  <text x="${(3 * width) / 4}" y="128" text-anchor="middle" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="12">Longest Streak</text>
  <text x="${(3 * width) / 4}" y="145" text-anchor="middle" fill="#64748B" font-family="Arial, sans-serif" font-size="11">days</text>

  <text x="${width / 2}" y="178" text-anchor="middle" fill="#64748B" font-family="Arial, sans-serif" font-size="11">Total contributions this year: ${totalContributions}</text>
</svg>`;
}

function generateTopLanguagesSvg({ langs }) {
  const width = 495;
  const barHeight = 8;
  const rowHeight = 24;
  const headerHeight = 68;
  const footerHeight = 16;
  const height = headerHeight + langs.length * rowHeight + footerHeight;

  const rows = langs
    .map((l, i) => {
      const barY = headerHeight + i * rowHeight;
      const barWidth = Math.max(2, Math.round(l.pct * (width - 130)));
      const pctText = `${(l.pct * 100).toFixed(1)}%`;
      return `
    <circle cx="30" cy="${barY + barHeight / 2 + 1}" r="5" fill="${langColor(l.lang)}"/>
    <text x="42" y="${barY + barHeight / 2 + 5}" fill="#C9D5E8" font-family="Arial, sans-serif" font-size="12">${escapeXml(l.lang)}</text>
    <rect x="130" y="${barY}" width="${barWidth}" height="${barHeight}" rx="4" fill="${langColor(l.lang)}" opacity="0.85"/>
    <text x="${width - 10}" y="${barY + barHeight / 2 + 5}" text-anchor="end" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="11">${pctText}</text>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="tl-title">
  <title id="tl-title">Top Languages for ${escapeXml(githubLogin)}</title>
  <defs>
    <linearGradient id="tl-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#101827"/>
      <stop offset="100%" stop-color="#16243D"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="10" fill="url(#tl-bg)"/>
  <text x="30" y="36" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="17" font-weight="700">💻 Top Languages</text>
  <text x="30" y="54" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="11">${escapeXml(githubLogin)} · own repositories only</text>
  <line x1="30" y1="62" x2="${width - 30}" y2="62" stroke="#26334D" stroke-width="1"/>
  ${rows}
</svg>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Fetching user profile...");
  const user = await fetchUser();

  console.log("Fetching repositories...");
  const repos = await fetchRepos();
  const totalStars = repos
    .filter((r) => !r.fork)
    .reduce((s, r) => s + r.stargazers_count, 0);

  console.log("Fetching contribution calendar...");
  const calendar = await fetchContributionCalendar();
  const streaks = calculateStreaks(calendar);
  const totalContributions = calendar.totalContributions;

  console.log("Fetching language data...");
  const { langs } = await fetchLanguages(repos);

  const assetsDir = path.join(process.cwd(), "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  const overviewSvg = generateOverviewSvg({
    ...user,
    totalStars,
    totalContributions,
  });
  fs.writeFileSync(path.join(assetsDir, "github-overview.svg"), overviewSvg + "\n", "utf8");
  console.log("Generated assets/github-overview.svg");

  const streakSvg = generateStreakSvg({ ...streaks, totalContributions });
  fs.writeFileSync(path.join(assetsDir, "github-streak.svg"), streakSvg + "\n", "utf8");
  console.log("Generated assets/github-streak.svg");

  const topLangsSvg = generateTopLanguagesSvg({ langs });
  fs.writeFileSync(path.join(assetsDir, "github-top-languages.svg"), topLangsSvg + "\n", "utf8");
  console.log("Generated assets/github-top-languages.svg");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
