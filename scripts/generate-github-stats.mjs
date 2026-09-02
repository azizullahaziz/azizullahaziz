import fs from "node:fs";
import path from "node:path";
import {
  createGitHubClient,
  discoverRepositories,
  escapeXml,
  getConfiguredLogin,
  getGitHubToken,
} from "./github-analytics-common.mjs";

const configuredLogin = getConfiguredLogin();
const githubToken = getGitHubToken();

const client = createGitHubClient({
  token: githubToken,
  userAgent: "azizullahaziz-github-stats",
});

async function fetchUser() {
  const data = await client.githubGet(`https://api.github.com/users/${configuredLogin}`);
  return {
    publicRepos: data.public_repos,
    followers: data.followers,
    following: data.following,
  };
}

async function fetchOwnedRepos() {
  const repos = [];
  let page = 1;
  while (true) {
    const data = await client.githubGet(
      `https://api.github.com/users/${configuredLogin}/repos?per_page=100&page=${page}&type=owner`
    );
    repos.push(...data);
    if (data.length < 100) break;
    page += 1;
  }
  return repos;
}

async function fetchContributionCalendar(login) {
  const data = await client.graphql(
    `query($login: String!) {
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
    }`,
    { login }
  );

  return data.user.contributionsCollection.contributionCalendar;
}

function calculateStreaks(calendar) {
  const days = calendar.weeks.flatMap((w) => w.contributionDays).sort((a, b) => a.date.localeCompare(b.date));

  let currentStreak = 0;
  let longestStreak = 0;
  let streak = 0;
  const today = new Date().toISOString().slice(0, 10);

  let i = days.length - 1;
  if (days[i] && days[i].date === today && days[i].contributionCount === 0) i -= 1;
  while (i >= 0 && days[i].contributionCount > 0) {
    currentStreak += 1;
    i -= 1;
  }

  for (const day of days) {
    if (day.contributionCount > 0) {
      streak += 1;
      if (streak > longestStreak) longestStreak = streak;
    } else {
      streak = 0;
    }
  }

  return { currentStreak, longestStreak };
}

async function fetchLanguages(repositories, concurrency = 5) {
  const candidates = repositories.filter((r) => !r.isFork);
  const langBytes = new Map();
  const skippedRepositories = [];

  let scannedRepositories = 0;
  let repositoriesWithLanguageData = 0;
  let index = 0;

  async function worker() {
    while (true) {
      const current = candidates[index++];
      if (!current) return;

      scannedRepositories += 1;
      try {
        const langs = await client.githubGet(`https://api.github.com/repos/${current.nameWithOwner}/languages`);
        const entries = Object.entries(langs || {});
        if (entries.length > 0) repositoriesWithLanguageData += 1;
        for (const [lang, bytes] of entries) {
          langBytes.set(lang, (langBytes.get(lang) || 0) + Number(bytes));
        }
      } catch (error) {
        skippedRepositories.push(`${current.nameWithOwner}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(candidates.length, 1)) }, () => worker()));

  const total = Array.from(langBytes.values()).reduce((sum, value) => sum + value, 0);
  const langs = Array.from(langBytes.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([lang, bytes]) => ({
      lang,
      bytes,
      pct: total > 0 ? bytes / total : 0,
    }));

  return {
    langs,
    total,
    diagnostics: {
      accessibleRepositories: candidates.length,
      scannedRepositories,
      repositoriesWithLanguageData,
      skippedRepositories,
    },
  };
}

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
  <title id="ov-title">GitHub Overview for ${escapeXml(configuredLogin)}</title>
  <defs>
    <linearGradient id="ov-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#101827"/>
      <stop offset="100%" stop-color="#16243D"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="10" fill="url(#ov-bg)"/>
  <text x="30" y="40" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="17" font-weight="700">📊 GitHub Overview</text>
  <text x="30" y="58" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="11">${escapeXml(configuredLogin)}</text>
  <line x1="30" y1="66" x2="${width - 30}" y2="66" stroke="#26334D" stroke-width="1"/>
  ${rows}
</svg>`;
}

function generateStreakSvg({ currentStreak, longestStreak, totalContributions }) {
  const width = 495;
  const height = 195;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="sk-title">
  <title id="sk-title">GitHub Contribution Streak for ${escapeXml(configuredLogin)}</title>
  <defs>
    <linearGradient id="sk-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#101827"/>
      <stop offset="100%" stop-color="#16243D"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="10" fill="url(#sk-bg)"/>
  <text x="${width / 2}" y="36" text-anchor="middle" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="17" font-weight="700">🔥 Contribution Streak</text>
  <text x="${width / 2}" y="54" text-anchor="middle" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="11">${escapeXml(configuredLogin)}</text>

  <text x="${width / 4}" y="105" text-anchor="middle" fill="#00D4FF" font-family="Arial, sans-serif" font-size="42" font-weight="700">${currentStreak}</text>
  <text x="${width / 4}" y="128" text-anchor="middle" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="12">Current Streak</text>
  <text x="${width / 4}" y="145" text-anchor="middle" fill="#64748B" font-family="Arial, sans-serif" font-size="11">days</text>

  <line x1="${width / 2}" y1="75" x2="${width / 2}" y2="155" stroke="#26334D" stroke-width="1"/>

  <text x="${(3 * width) / 4}" y="105" text-anchor="middle" fill="#9B7CFF" font-family="Arial, sans-serif" font-size="42" font-weight="700">${longestStreak}</text>
  <text x="${(3 * width) / 4}" y="128" text-anchor="middle" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="12">Longest Streak</text>
  <text x="${(3 * width) / 4}" y="145" text-anchor="middle" fill="#64748B" font-family="Arial, sans-serif" font-size="11">days</text>

  <text x="${width / 2}" y="178" text-anchor="middle" fill="#64748B" font-family="Arial, sans-serif" font-size="11">Total contributions this year: ${totalContributions}</text>
</svg>`;
}

function generateTopLanguagesSvg({ langs, discovery, diagnostics }) {
  const width = 495;
  const barHeight = 8;
  const rowHeight = 24;
  const headerHeight = 86;
  const footerHeight = 40;

  const hasData = langs.length > 0;
  const height = headerHeight + Math.max(langs.length, 2) * rowHeight + footerHeight;

  const rows = hasData
    ? langs
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
        .join("")
    : `
    <text x="30" y="${headerHeight + 16}" fill="#C9D5E8" font-family="Arial, sans-serif" font-size="12">No language bytes found in scanned accessible repositories.</text>
    <text x="30" y="${headerHeight + 36}" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="11">Diagnostics: scanned ${diagnostics.scannedRepositories}, skipped ${diagnostics.skippedRepositories.length}, with data ${diagnostics.repositoriesWithLanguageData}.</text>`;

  const scopeText = `Accessible/discoverable repositories (owned, contributed, org, PR/review-linked) · forks excluded`; 
  const diagText = `Repos discovered ${discovery.diagnostics.discoveredRepositoryCount} (public ${discovery.diagnostics.publicRepositoryCount}, private ${discovery.diagnostics.privateRepositoryCount}) · scanned ${diagnostics.scannedRepositories}/${diagnostics.accessibleRepositories} · skipped ${diagnostics.skippedRepositories.length}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="tl-title">
  <title id="tl-title">Top Languages for ${escapeXml(configuredLogin)}</title>
  <defs>
    <linearGradient id="tl-bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#101827"/>
      <stop offset="100%" stop-color="#16243D"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" rx="10" fill="url(#tl-bg)"/>
  <text x="30" y="36" fill="#FFFFFF" font-family="Arial, sans-serif" font-size="17" font-weight="700">💻 Top Languages</text>
  <text x="30" y="53" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="10">${escapeXml(scopeText)}</text>
  <text x="30" y="67" fill="#8B9BB4" font-family="Arial, sans-serif" font-size="10">${escapeXml(diagText)}</text>
  <line x1="30" y1="74" x2="${width - 30}" y2="74" stroke="#26334D" stroke-width="1"/>
  ${rows}
  <text x="30" y="${height - 12}" fill="#64748B" font-family="Arial, sans-serif" font-size="10">Private organization repositories require token permission and organization SSO authorization.</text>
</svg>`;
}

async function main() {
  console.log("Fetching user profile...");
  const user = await fetchUser();

  console.log("Fetching owned repositories for stars...");
  const ownedRepos = await fetchOwnedRepos();
  const totalStars = ownedRepos.filter((r) => !r.fork).reduce((sum, repo) => sum + repo.stargazers_count, 0);

  console.log("Discovering repositories for analytics scope...");
  const discovery = await discoverRepositories({ client, login: configuredLogin });
  console.log(`[Discovery] Repositories=${discovery.diagnostics.discoveredRepositoryCount} public=${discovery.diagnostics.publicRepositoryCount} private=${discovery.diagnostics.privateRepositoryCount}`);
  if (discovery.diagnostics.sourceFailures.length > 0) {
    console.log(`[Discovery] Source failures: ${discovery.diagnostics.sourceFailures.join(" | ")}`);
  }
  if (discovery.diagnostics.warnings.length > 0) {
    console.log(`[Discovery] Warnings: ${discovery.diagnostics.warnings.join(" | ")}`);
  }

  console.log("Fetching contribution calendar...");
  const calendar = await fetchContributionCalendar(discovery.login);
  const streaks = calculateStreaks(calendar);
  const totalContributions = calendar.totalContributions;

  console.log("Fetching language data from discoverable repositories...");
  const { langs, diagnostics: languageDiagnostics } = await fetchLanguages(discovery.repositories, 5);
  console.log(`[Languages] Accessible repositories (forks excluded)=${languageDiagnostics.accessibleRepositories}`);
  console.log(`[Languages] Scanned=${languageDiagnostics.scannedRepositories} withData=${languageDiagnostics.repositoriesWithLanguageData} skipped=${languageDiagnostics.skippedRepositories.length}`);
  if (languageDiagnostics.skippedRepositories.length > 0) {
    console.log(`[Languages] Skipped detail: ${languageDiagnostics.skippedRepositories.slice(0, 5).join(" | ")}${languageDiagnostics.skippedRepositories.length > 5 ? ` | +${languageDiagnostics.skippedRepositories.length - 5} more` : ""}`);
  }

  const assetsDir = path.join(process.cwd(), "assets");
  fs.mkdirSync(assetsDir, { recursive: true });

  fs.writeFileSync(
    path.join(assetsDir, "github-overview.svg"),
    generateOverviewSvg({ ...user, totalStars, totalContributions }) + "\n",
    "utf8"
  );
  console.log("Generated assets/github-overview.svg");

  fs.writeFileSync(
    path.join(assetsDir, "github-streak.svg"),
    generateStreakSvg({ ...streaks, totalContributions }) + "\n",
    "utf8"
  );
  console.log("Generated assets/github-streak.svg");

  fs.writeFileSync(
    path.join(assetsDir, "github-top-languages.svg"),
    generateTopLanguagesSvg({ langs, discovery, diagnostics: languageDiagnostics }) + "\n",
    "utf8"
  );
  console.log("Generated assets/github-top-languages.svg");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
