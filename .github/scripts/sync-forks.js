'use strict';

const fs = require('fs');
const path = require('path');

const org = process.env.ORG_NAME;
const token = process.env.GITHUB_TOKEN;
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const requestAttempts = Number(process.env.REQUEST_ATTEMPTS || 4);
const requestRetryCapMs = Number(process.env.REQUEST_RETRY_CAP_MS || 60000);
const syncDelayMs = Number(process.env.SYNC_DELAY_MS || 2000);
const resultsFile = process.env.SYNC_RESULTS_FILE || path.join(process.env.RUNNER_TEMP || process.cwd(), 'fork-sync-results.json');

class GitHubApiError extends Error {
  constructor(message, { status, headers, response } = {}) {
    super(message);
    this.name = 'GitHubApiError';
    this.status = status;
    this.headers = headers || new Headers();
    this.response = response;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryAfterMs(headers) {
  const retryAfter = headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return seconds * 1000;
    }

    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) {
      return Math.max(0, retryDate - Date.now());
    }
  }

  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (remaining === '0' && reset) {
    const resetTime = Number(reset) * 1000;
    if (Number.isFinite(resetTime)) {
      return Math.max(0, resetTime - Date.now());
    }
  }

  return null;
}

function shouldRetry(error) {
  if (error.name === 'AbortError') {
    return true;
  }

  if (!(error instanceof GitHubApiError)) {
    return true;
  }

  if ([408, 429, 500, 502, 503, 504].includes(error.status)) {
    return true;
  }

  const message = String(error.message || '').toLowerCase();
  return error.status === 403 && message.includes('rate limit');
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) {
    return { text, data: {} };
  }

  try {
    return { text, data: JSON.parse(text) };
  } catch {
    return { text, data: null };
  }
}

async function requestGitHub(path, { method = 'GET', body } = {}) {
  const url = `https://api.github.com${path}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'GitHub-Actions-Fork-Sync',
    'X-GitHub-Api-Version': '2022-11-28'
  };

  let lastError;

  for (let attempt = 1; attempt <= requestAttempts; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers: body ? { ...headers, 'Content-Type': 'application/json' } : headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal
      });

      const { text, data } = await readResponse(response);
      const remaining = response.headers.get('x-ratelimit-remaining');
      const limit = response.headers.get('x-ratelimit-limit');

      if (remaining !== null && Number(remaining) < 100) {
        console.log(`Rate limit: ${remaining}/${limit || '?'} remaining`);
      }

      if (response.ok) {
        return data;
      }

      const message = data?.message || text || response.statusText;
      throw new GitHubApiError(`HTTP ${response.status}: ${message}`, {
        status: response.status,
        headers: response.headers,
        response: data || text
      });
    } catch (error) {
      lastError = error;

      if (attempt >= requestAttempts || !shouldRetry(error)) {
        throw error;
      }

      const headerDelay = error instanceof GitHubApiError ? retryAfterMs(error.headers) : null;
      const backoff = headerDelay ?? Math.min(requestRetryCapMs, 1000 * 2 ** (attempt - 1));
      console.log(`Request failed (${error.message}); retrying in ${Math.ceil(backoff / 1000)}s (${attempt}/${requestAttempts})`);
      await delay(backoff);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError;
}

function encode(value) {
  return encodeURIComponent(value);
}

async function listReposPage(owner, page) {
  const query = `per_page=100&page=${page}&type=forks`;

  try {
    return await requestGitHub(`/orgs/${encode(owner)}/repos?${query}`);
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 404) {
      throw error;
    }

    return requestGitHub(`/users/${encode(owner)}/repos?${query}`);
  }
}

function repoSourceUrl(repo) {
  return repo.parent?.html_url || repo.source?.html_url || repo.html_url || `https://github.com/${repo.full_name}`;
}

async function getAllForks(owner) {
  const allRepos = [];

  for (let page = 1; ; page++) {
    const repos = await listReposPage(owner, page);

    if (!Array.isArray(repos) || repos.length === 0) {
      break;
    }

    allRepos.push(
      ...repos
        .filter(repo => repo.fork)
        .map(repo => ({
          name: repo.name,
          nameWithOwner: repo.full_name,
          defaultBranch: repo.default_branch || 'main',
          archived: Boolean(repo.archived),
          disabled: Boolean(repo.disabled),
          sourceUrl: repoSourceUrl(repo),
          description: repo.description || ''
        }))
    );

    if (repos.length < 100) {
      break;
    }
  }

  return allRepos;
}

async function syncRepo(repoFullName, branch = 'main') {
  const [owner, repo] = repoFullName.split('/');

  try {
    const response = await requestGitHub(`/repos/${encode(owner)}/${encode(repo)}/merge-upstream`, {
      method: 'POST',
      body: { branch }
    });

    return {
      success: true,
      message: response?.message || 'Success',
      sourceUrl: null
    };
  } catch (error) {
    let message = error.message;

    if (error instanceof GitHubApiError) {
      if (error.status === 409) {
        message = 'Cannot sync - merge conflict with upstream';
      } else if (error.status === 422) {
        message = 'Cannot sync - may have conflicts or custom commits';
      } else if (error.status === 403) {
        message = 'Forbidden - insufficient permissions or rate limited';
      } else if (error.status === 404) {
        message = 'Repository not found or not a fork';
      }
    }

    return { success: false, message, sourceUrl: null };
  }
}

function skipReason(repo) {
  const reasons = [];
  if (repo.archived) {
    reasons.push('archived');
  }
  if (repo.disabled) {
    reasons.push('disabled');
  }

  return reasons.length > 0 ? `Skipped - repository is ${reasons.join(' and ')}` : null;
}

function setOutput(name, value) {
  const outputFile = process.env.GITHUB_OUTPUT;
  if (!outputFile) {
    return;
  }

  const text = String(value);
  const delimiter = `fork_sync_${name}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  fs.appendFileSync(outputFile, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
}

function writeResultsFile(results) {
  fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
  fs.writeFileSync(resultsFile, `${JSON.stringify(results, null, 2)}\n`);
}

function writeOutputs({ results, total, successCount, failedCount, skippedCount }) {
  writeResultsFile(results);
  setOutput('summary-file', resultsFile);
  setOutput('total', total);
  setOutput('success', successCount);
  setOutput('failed', failedCount);
  setOutput('skipped', skippedCount);
}

async function main() {
  if (!org) {
    throw new Error('ORG_NAME is required');
  }

  if (!token) {
    throw new Error('FORK_SYNC_PAT secret is required to sync forked repositories across the owner account');
  }

  console.log(`Fetching forked repositories for ${org}...`);
  const forkedRepos = await getAllForks(org);
  console.log(`Found ${forkedRepos.length} forked repositories`);

  const results = [];
  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  let attemptedSyncs = 0;

  for (let index = 0; index < forkedRepos.length; index++) {
    const repo = forkedRepos[index];
    const skipped = skipReason(repo);

    if (skipped) {
      skippedCount++;
      console.log(`SKIPPED ${repo.nameWithOwner} (${skipped})`);
      results.push({
        repo: repo.nameWithOwner,
        status: 'skipped',
        message: skipped,
        parent: repo.sourceUrl,
        branch: repo.defaultBranch
      });
      continue;
    }

    if (attemptedSyncs > 0 && syncDelayMs > 0) {
      await delay(syncDelayMs);
    }
    attemptedSyncs++;

    console.log(`[${index + 1}/${forkedRepos.length}] Syncing ${repo.nameWithOwner} (${repo.defaultBranch})...`);

    const result = await syncRepo(repo.nameWithOwner, repo.defaultBranch);
    const status = result.success ? 'success' : 'failed';
    console.log(`${status.toUpperCase()} ${repo.nameWithOwner}${result.message !== 'Success' ? ` (${result.message})` : ''}`);

    if (result.success) {
      successCount++;
    } else {
      failedCount++;
    }

    results.push({
      repo: repo.nameWithOwner,
      status,
      message: result.message,
      parent: result.sourceUrl || repo.sourceUrl,
      branch: repo.defaultBranch
    });
  }

  writeOutputs({ results, total: forkedRepos.length, successCount, failedCount, skippedCount });
  console.log(`Successfully synced ${successCount}/${attemptedSyncs} attempted repositories; failed ${failedCount}; skipped ${skippedCount}`);
}

main().catch(error => {
  const message = error.message || String(error);
  const detail = error.stack || message;
  console.error('Fatal error:', detail);

  writeOutputs({
    results: [{
      repo: org || 'unknown',
      status: 'failed',
      message,
      parent: '',
      branch: ''
    }],
    total: 0,
    successCount: 0,
    failedCount: 1,
    skippedCount: 0
  });
});
