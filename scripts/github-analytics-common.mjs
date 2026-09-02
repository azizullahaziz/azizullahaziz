const DEFAULT_LOGIN = "azizullahaziz";

export function getConfiguredLogin() {
  return process.env.GITHUB_LOGIN || DEFAULT_LOGIN;
}

export function getGitHubToken() {
  const token = process.env.PROFILE_ANALYTICS_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("PROFILE_ANALYTICS_TOKEN or GITHUB_TOKEN is required.");
  }
  return token;
}

export function createMonthBuckets(lastNMonths = 12, now = new Date()) {
  const months = [];
  for (let index = lastNMonths - 1; index >= 0; index--) {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - index, 1));
    months.push({
      key: `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`,
      label: date.toLocaleString("en-US", { month: "short", timeZone: "UTC" }),
      pullRequests: 0,
      reviews: 0,
    });
  }

  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (lastNMonths - 1), 1, 0, 0, 0));
  const endExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));

  return { months, start, endExclusive };
}

export function isWithinRange(dateString, start, endExclusive) {
  const value = new Date(dateString);
  return !Number.isNaN(value.getTime()) && value >= start && value < endExclusive;
}

export function toMonthKey(dateString) {
  return new Date(dateString).toISOString().slice(0, 7);
}

export function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createGitHubClient({ token, userAgent }) {
  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `token ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": userAgent,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(options.headers || {}),
      },
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }

    if (!response.ok) {
      const error = new Error(`GitHub API error ${response.status} for ${url}`);
      error.status = response.status;
      error.url = url;
      error.payload = data;
      throw error;
    }

    return {
      data,
      headers: response.headers,
    };
  }

  async function githubGet(url) {
    const response = await request(url);
    return response.data;
  }

  async function graphql(query, variables = {}) {
    const { data } = await request("https://api.github.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });

    if (!data || typeof data !== "object") {
      throw new Error("GraphQL response is malformed.");
    }

    if (Array.isArray(data.errors) && data.errors.length > 0) {
      const error = new Error(`GraphQL errors: ${JSON.stringify(data.errors)}`);
      error.payload = data.errors;
      throw error;
    }

    if (!data.data) {
      throw new Error(`GraphQL response missing data: ${JSON.stringify(data)}`);
    }

    return data.data;
  }

  return { request, githubGet, graphql };
}

function normalizeRepo(node) {
  if (!node || !node.nameWithOwner || !node.owner?.login || !node.name) {
    return null;
  }
  return {
    key: node.nameWithOwner,
    owner: node.owner.login,
    name: node.name,
    nameWithOwner: node.nameWithOwner,
    isPrivate: !!node.isPrivate,
    isFork: !!node.isFork,
    sources: new Set(),
  };
}

function addRepo(repoMap, node, source) {
  const normalized = normalizeRepo(node);
  if (!normalized) return;
  const existing = repoMap.get(normalized.key) || normalized;
  existing.isPrivate = existing.isPrivate || normalized.isPrivate;
  existing.isFork = existing.isFork || normalized.isFork;
  existing.sources.add(source);
  repoMap.set(normalized.key, existing);
}

async function paginateGraphQLConnection({ fetchPage, diagnostics, sourceName }) {
  const nodes = [];
  let cursor = null;
  while (true) {
    const connection = await fetchPage(cursor);
    if (!connection || !Array.isArray(connection.nodes)) {
      diagnostics.warnings.push(`${sourceName}: malformed connection response`);
      break;
    }
    nodes.push(...connection.nodes);
    if (!connection.pageInfo?.hasNextPage) break;
    cursor = connection.pageInfo.endCursor;
    await sleep(150);
  }
  return nodes;
}

async function discoverOwnedRepositories({ graphql, login, repoMap, diagnostics }) {
  const nodes = await paginateGraphQLConnection({
    sourceName: "owned",
    diagnostics,
    fetchPage: async (after) => {
      const data = await graphql(
        `query($login: String!, $after: String) {
          user(login: $login) {
            repositories(first: 100, after: $after, ownerAffiliations: OWNER, orderBy: {field: UPDATED_AT, direction: DESC}) {
              pageInfo { hasNextPage endCursor }
              nodes { name nameWithOwner isPrivate isFork owner { login } }
            }
          }
        }`,
        { login, after }
      );
      return data.user?.repositories;
    },
  });

  for (const node of nodes) addRepo(repoMap, node, "owned");
}

async function discoverContributedRepositories({ graphql, login, repoMap, diagnostics }) {
  const nodes = await paginateGraphQLConnection({
    sourceName: "contributed",
    diagnostics,
    fetchPage: async (after) => {
      const data = await graphql(
        `query($login: String!, $after: String) {
          user(login: $login) {
            repositoriesContributedTo(
              first: 100,
              after: $after,
              includeUserRepositories: true,
              contributionTypes: [COMMIT, ISSUE, PULL_REQUEST, REPOSITORY],
              orderBy: {field: UPDATED_AT, direction: DESC}
            ) {
              pageInfo { hasNextPage endCursor }
              nodes { name nameWithOwner isPrivate isFork owner { login } }
            }
          }
        }`,
        { login, after }
      );
      return data.user?.repositoriesContributedTo;
    },
  });

  for (const node of nodes) addRepo(repoMap, node, "contributed");
}

async function discoverOrganizationRepositories({ graphql, login, repoMap, diagnostics }) {
  const organizations = await paginateGraphQLConnection({
    sourceName: "organizations",
    diagnostics,
    fetchPage: async (after) => {
      const data = await graphql(
        `query($login: String!, $after: String) {
          user(login: $login) {
            organizations(first: 100, after: $after) {
              pageInfo { hasNextPage endCursor }
              nodes { login }
            }
          }
        }`,
        { login, after }
      );
      return data.user?.organizations;
    },
  });

  for (const org of organizations) {
    if (!org?.login) continue;
    try {
      const orgRepos = await paginateGraphQLConnection({
        sourceName: `org:${org.login}`,
        diagnostics,
        fetchPage: async (after) => {
          const data = await graphql(
            `query($org: String!, $after: String) {
              organization(login: $org) {
                repositories(
                  first: 100,
                  after: $after,
                  affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
                  orderBy: {field: UPDATED_AT, direction: DESC}
                ) {
                  pageInfo { hasNextPage endCursor }
                  nodes { name nameWithOwner isPrivate isFork owner { login } }
                }
              }
            }`,
            { org: org.login, after }
          );
          return data.organization?.repositories;
        },
      });

      for (const repo of orgRepos) addRepo(repoMap, repo, "organization");
    } catch (error) {
      diagnostics.warnings.push(`organization repository discovery failed for ${org.login}: ${error.message}`);
    }
  }
}

async function discoverSearchRepositories({ request, repoMap, diagnostics, sourceName, query }) {
  let page = 1;
  while (true) {
    const encoded = encodeURIComponent(query);
    const url = `https://api.github.com/search/issues?q=${encoded}&per_page=100&page=${page}`;
    const { data } = await request(url);

    if (!data || !Array.isArray(data.items)) {
      diagnostics.warnings.push(`${sourceName}: malformed search response for page ${page}`);
      break;
    }

    for (const item of data.items) {
      const fullName = item?.repository_url?.split("/repos/")[1];
      if (!fullName || !fullName.includes("/")) continue;
      const [owner, ...rest] = fullName.split("/");
      const name = rest.join("/");
      addRepo(
        repoMap,
        {
          name,
          nameWithOwner: `${owner}/${name}`,
          isPrivate: !!item.repository?.private,
          isFork: false,
          owner: { login: owner },
        },
        sourceName
      );
    }

    if (data.items.length < 100 || page >= 10) break;
    page += 1;
    await sleep(350);
  }
}

async function discoverContributionRepositories({ graphql, login, repoMap, diagnostics }) {
  const to = new Date();
  const from = new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), to.getUTCDate()));
  let cursor = null;

  for (const contributionType of ["pullRequestContributions", "pullRequestReviewContributions"]) {
    cursor = null;
    while (true) {
      const data = await graphql(
        `query($login: String!, $from: DateTime!, $to: DateTime!, $after: String) {
          user(login: $login) {
            contributionsCollection(from: $from, to: $to) {
              ${contributionType}(first: 100, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  repository { name nameWithOwner isPrivate isFork owner { login } }
                }
              }
            }
          }
        }`,
        { login, from: from.toISOString(), to: to.toISOString(), after: cursor }
      );
      const connection = data.user?.contributionsCollection?.[contributionType];
      if (!connection || !Array.isArray(connection.nodes)) {
        diagnostics.warnings.push(`activity repositories: malformed ${contributionType} response`);
        break;
      }
      for (const node of connection.nodes) addRepo(repoMap, node?.repository, "activity");
      if (!connection.pageInfo?.hasNextPage) break;
      cursor = connection.pageInfo.endCursor;
      await sleep(150);
    }
  }
}

export async function discoverRepositories({ client, login }) {
  const diagnostics = {
    warnings: [],
    sourceFailures: [],
  };

  const repoMap = new Map();
  let canonicalLogin = login;

  try {
    const viewer = await client.graphql(
      `query($login: String!) {
        viewer { login }
        user(login: $login) { login }
      }`,
      { login }
    );
    canonicalLogin = viewer.user?.login || viewer.viewer?.login || login;
  } catch (error) {
    diagnostics.warnings.push(`failed to resolve canonical login: ${error.message}`);
  }

  const sources = [
    { key: "owned", run: () => discoverOwnedRepositories({ graphql: client.graphql, login: canonicalLogin, repoMap, diagnostics }) },
    { key: "contributed", run: () => discoverContributedRepositories({ graphql: client.graphql, login: canonicalLogin, repoMap, diagnostics }) },
    { key: "organization", run: () => discoverOrganizationRepositories({ graphql: client.graphql, login: canonicalLogin, repoMap, diagnostics }) },
    { key: "activity", run: () => discoverContributionRepositories({ graphql: client.graphql, login: canonicalLogin, repoMap, diagnostics }) },
    {
      key: "authored-pr-search",
      run: () =>
        discoverSearchRepositories({
          request: client.request,
          repoMap,
          diagnostics,
          sourceName: "authored-pr-search",
          query: `type:pr author:${canonicalLogin}`,
        }),
    },
    {
      key: "reviewed-pr-search",
      run: () =>
        discoverSearchRepositories({
          request: client.request,
          repoMap,
          diagnostics,
          sourceName: "reviewed-pr-search",
          query: `type:pr reviewed-by:${canonicalLogin}`,
        }),
    },
  ];

  for (const source of sources) {
    try {
      await source.run();
    } catch (error) {
      diagnostics.sourceFailures.push(`${source.key}: ${error.message}`);
    }
  }

  const repositories = Array.from(repoMap.values())
    .map((repo) => ({
      ...repo,
      sources: Array.from(repo.sources).sort(),
    }))
    .sort((a, b) => a.nameWithOwner.localeCompare(b.nameWithOwner));

  const publicCount = repositories.filter((r) => !r.isPrivate).length;
  const privateCount = repositories.filter((r) => r.isPrivate).length;

  return {
    login: canonicalLogin,
    repositories,
    diagnostics: {
      ...diagnostics,
      discoveredRepositoryCount: repositories.length,
      publicRepositoryCount: publicCount,
      privateRepositoryCount: privateCount,
    },
  };
}
