'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const REPORT_LABEL = 'fork-sync-status';
const STATE_PATTERN = /<!-- fork-sync-state:v1\s+([A-Za-z0-9+/=]+)\s+-->/;
const org = process.env.ORG_NAME;
const token = process.env.GITHUB_TOKEN;
const statusToken = process.env.STATUS_TOKEN;
const statusRepository = process.env.STATUS_REPOSITORY;
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const requestAttempts = Number(process.env.REQUEST_ATTEMPTS || 4);
const requestRetryCapMs = Number(process.env.REQUEST_RETRY_CAP_MS || 60000);
const syncDelayMs = Number(process.env.SYNC_DELAY_MS || 5000);
const resultsFile = process.env.SYNC_RESULTS_FILE || path.join(process.env.RUNNER_TEMP || process.cwd(), 'fork-sync-results.json');
const maxReposPerRun = parsePositiveInteger(process.env.MAX_REPOS_PER_RUN, 50);
const minSyncAgeHours = parseNonNegativeNumber(process.env.MIN_SYNC_AGE_HOURS, 24);
const minSyncAgeMs = minSyncAgeHours * 60 * 60 * 1000;
const blockedRetryHours = parseNonNegativeNumber(process.env.BLOCKED_RETRY_HOURS, 168);
const blockedRetryMs = blockedRetryHours * 60 * 60 * 1000;
const forceBlockedSync = parseBoolean(process.env.FORCE_BLOCKED_SYNC, true);

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

function parsePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function parseNonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
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

async function requestGitHub(path, { method = 'GET', body, authToken = token } = {}) {
  const url = `https://api.github.com${path}`;
  const headers = {
    Authorization: `Bearer ${authToken}`,
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

function emptySyncState() {
  return { version: 1, repos: {} };
}

function decodeSyncState(body) {
  const match = String(body || '').match(STATE_PATTERN);
  if (!match) {
    return emptySyncState();
  }

  try {
    const json = zlib.gunzipSync(Buffer.from(match[1], 'base64')).toString('utf8');
    const parsed = JSON.parse(json);
    return parsed && typeof parsed.repos === 'object' ? parsed : emptySyncState();
  } catch (error) {
    console.log(`Could not decode previous sync state: ${error.message}`);
    return emptySyncState();
  }
}

async function getPreviousSyncState() {
  if (!statusToken || !statusRepository) {
    return emptySyncState();
  }

  const [owner, repo] = statusRepository.split('/');
  if (!owner || !repo) {
    return emptySyncState();
  }

  try {
    const issues = await requestGitHub(`/repos/${encode(owner)}/${encode(repo)}/issues?state=open&labels=${encode(REPORT_LABEL)}&per_page=100`, {
      authToken: statusToken
    });
    const existingIssue = Array.isArray(issues) ? issues.find(issue => issue.title?.includes('Fork Sync Status')) : null;
    return decodeSyncState(existingIssue?.body);
  } catch (error) {
    console.log(`Could not load previous sync state: ${error.message}`);
    return emptySyncState();
  }
}

function lastSuccessfulSyncTime(syncState, repoFullName) {
  const value = syncState.repos?.[repoFullName]?.lastSuccessfulSync;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function repoState(syncState, repoFullName) {
  return syncState.repos?.[repoFullName] || {};
}

function parseTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

function formatAge(ms) {
  const minutes = Math.max(1, Math.floor(ms / 60000));
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function recentlySyncedReason(repo, syncState, now) {
  const lastSync = lastSuccessfulSyncTime(syncState, repo.nameWithOwner);
  if (lastSync === null || minSyncAgeMs === 0) {
    return null;
  }

  const age = now - lastSync;
  if (age >= 0 && age < minSyncAgeMs) {
    return `Skipped - successfully synced ${formatAge(age)} ago`;
  }

  return null;
}

function upstreamMetadataFromState(repo, syncState, now) {
  const entry = repoState(syncState, repo.nameWithOwner);
  const upstreamPushedAt = entry.upstreamPushedAt || entry.lastSuccessfulUpstreamPushedAt;
  const upstreamCheckedAt = entry.upstreamCheckedAt;
  const pushedTime = parseTime(upstreamPushedAt);
  const checkedTime = parseTime(upstreamCheckedAt);

  if (pushedTime === null || checkedTime === null) {
    return null;
  }

  const refreshMs = upstreamActivityCooldownHours({ upstreamPushedAt }, now) * 60 * 60 * 1000;
  if (now - checkedTime >= refreshMs) {
    return null;
  }

  return {
    ...repo,
    upstreamName: entry.upstream || '',
    upstreamDefaultBranch: entry.upstreamDefaultBranch || repo.defaultBranch,
    upstreamUrl: entry.parent || repo.sourceUrl,
    upstreamPushedAt,
    upstreamCheckedAt,
    upstreamMetadataSource: 'cached'
  };
}

async function withUpstreamMetadata(repo) {
  const [owner, repoName] = repo.nameWithOwner.split('/');

  try {
    const details = await requestGitHub(`/repos/${encode(owner)}/${encode(repoName)}`);
    const upstream = details.parent || details.source;
    return {
      ...repo,
      upstreamName: upstream?.full_name || '',
      upstreamDefaultBranch: upstream?.default_branch || repo.defaultBranch,
      upstreamUrl: upstream?.html_url || repo.sourceUrl,
      upstreamPushedAt: upstream?.pushed_at || upstream?.updated_at || null,
      upstreamCheckedAt: new Date().toISOString(),
      upstreamMetadataSource: 'fresh'
    };
  } catch (error) {
    console.log(`Could not load upstream metadata for ${repo.nameWithOwner}: ${error.message}`);
    return {
      ...repo,
      upstreamName: '',
      upstreamDefaultBranch: repo.defaultBranch,
      upstreamUrl: repo.sourceUrl,
      upstreamPushedAt: null,
      upstreamCheckedAt: new Date().toISOString(),
      upstreamMetadataSource: 'error',
      upstreamMetadataError: error.message
    };
  }
}

function upstreamActivityCooldownHours(repo, now) {
  const upstreamTime = parseTime(repo.upstreamPushedAt);
  if (upstreamTime === null) {
    return minSyncAgeHours;
  }

  const upstreamAgeDays = Math.max(0, (now - upstreamTime) / 86400000);
  if (upstreamAgeDays <= 7) {
    return 24;
  }
  if (upstreamAgeDays <= 30) {
    return 72;
  }
  if (upstreamAgeDays <= 180) {
    return 168;
  }
  if (upstreamAgeDays <= 365) {
    return 720;
  }

  return 2160;
}

function upstreamAwareSkipReason(repo, syncState, now) {
  const lastSync = lastSuccessfulSyncTime(syncState, repo.nameWithOwner);
  if (lastSync === null) {
    return null;
  }

  const upstreamTime = parseTime(repo.upstreamPushedAt);
  if (upstreamTime !== null && upstreamTime <= lastSync) {
    return 'Skipped - upstream has not changed since last successful sync';
  }

  const cooldownHours = Math.max(minSyncAgeHours, upstreamActivityCooldownHours(repo, now));
  const cooldownMs = cooldownHours * 60 * 60 * 1000;
  const age = now - lastSync;
  if (age >= 0 && age < cooldownMs) {
    return `Skipped - upstream activity cooldown (${cooldownHours}h) has not elapsed`;
  }

  return null;
}

function blockedSyncRetryReason(repo, syncState, now) {
  const entry = repoState(syncState, repo.nameWithOwner);
  if (forceBlockedSync && !String(entry.lastMessage || '').includes('forced upstream reset failed')) {
    return null;
  }

  const lastBlocked = parseTime(entry.lastBlockedSync);
  if (lastBlocked === null || blockedRetryMs === 0) {
    return null;
  }

  const upstreamTime = parseTime(repo.upstreamPushedAt);
  const blockedUpstreamTime = parseTime(entry.lastBlockedUpstreamPushedAt);
  if (upstreamTime !== null && blockedUpstreamTime !== null && upstreamTime > blockedUpstreamTime) {
    return null;
  }

  const age = now - lastBlocked;
  if (age >= 0 && age < blockedRetryMs) {
    return `Skipped - previous automatic sync was blocked ${formatAge(age)} ago; retry after ${blockedRetryHours}h or upstream change`;
  }

  return null;
}

function addSkippedResult(results, repo, message) {
  results.push({
    repo: repo.nameWithOwner,
    status: 'skipped',
    message,
    parent: repo.upstreamUrl || repo.sourceUrl,
    branch: repo.defaultBranch,
    upstream: repo.upstreamName || '',
    upstreamDefaultBranch: repo.upstreamDefaultBranch || repo.defaultBranch,
    upstreamPushedAt: repo.upstreamPushedAt || null,
    upstreamCheckedAt: repo.upstreamCheckedAt || null,
    upstreamMetadataSource: repo.upstreamMetadataSource || ''
  });
}

function byOldestSuccessfulSync(syncState, now) {
  return (left, right) => {
    const leftTime = lastSuccessfulSyncTime(syncState, left.nameWithOwner) ?? 0;
    const rightTime = lastSuccessfulSyncTime(syncState, right.nameWithOwner) ?? 0;
    const leftCooldown = upstreamActivityCooldownHours(left, now);
    const rightCooldown = upstreamActivityCooldownHours(right, now);
    const leftUpstreamTime = parseTime(left.upstreamPushedAt) ?? 0;
    const rightUpstreamTime = parseTime(right.upstreamPushedAt) ?? 0;

    return leftCooldown - rightCooldown || rightUpstreamTime - leftUpstreamTime || leftTime - rightTime || left.nameWithOwner.localeCompare(right.nameWithOwner);
  };
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

function apiErrorMessage(error, fallback) {
  if (error instanceof GitHubApiError && error.response && typeof error.response === 'object') {
    return error.response.message || fallback;
  }

  return fallback;
}

function splitRepoFullName(fullName) {
  const [owner, repo] = String(fullName || '').split('/');
  return owner && repo ? { owner, repo } : null;
}

async function resetForkBranchToUpstream(repoFullName, branch, upstreamName, upstreamBranch) {
  const fork = splitRepoFullName(repoFullName);
  const upstream = splitRepoFullName(upstreamName);
  if (!fork || !upstream || !upstreamBranch) {
    return null;
  }

  const upstreamBranchDetails = await requestGitHub(`/repos/${encode(upstream.owner)}/${encode(upstream.repo)}/branches/${encode(upstreamBranch)}`);
  const targetSha = upstreamBranchDetails?.commit?.sha;
  if (!targetSha) {
    return null;
  }

  await requestGitHub(`/repos/${encode(fork.owner)}/${encode(fork.repo)}/git/refs/heads/${encode(branch)}`, {
    method: 'PATCH',
    body: { sha: targetSha, force: true }
  });

  return {
    status: 'success',
    message: `Reset ${branch} to upstream ${upstreamName}:${upstreamBranch} after merge-upstream could not auto-sync`,
    sourceUrl: null
  };
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

async function syncRepo(repoFullName, branch = 'main', upstreamName = '', upstreamBranch = branch) {
  const [owner, repo] = repoFullName.split('/');

  try {
    const response = await requestGitHub(`/repos/${encode(owner)}/${encode(repo)}/merge-upstream`, {
      method: 'POST',
      body: { branch }
    });

    return {
      status: 'success',
      message: response?.message || 'Success',
      sourceUrl: null
    };
  } catch (error) {
    let message = error.message;
    let status = 'failed';

    if (error instanceof GitHubApiError) {
      if (error.status === 409) {
        if (forceBlockedSync) {
          try {
            const reset = await resetForkBranchToUpstream(repoFullName, branch, upstreamName, upstreamBranch);
            if (reset) {
              return reset;
            }
          } catch (fallbackError) {
            status = 'blocked';
            message = `Blocked - ${apiErrorMessage(error, 'merge conflict with upstream')}; forced upstream reset failed: ${fallbackError.message}`;
            return { status, message, sourceUrl: null };
          }
        }

        status = 'blocked';
        message = `Blocked - ${apiErrorMessage(error, 'merge conflict with upstream')}`;
      } else if (error.status === 422) {
        if (forceBlockedSync) {
          try {
            const reset = await resetForkBranchToUpstream(repoFullName, branch, upstreamName, upstreamBranch);
            if (reset) {
              return reset;
            }
          } catch (fallbackError) {
            status = 'blocked';
            message = `Blocked - ${apiErrorMessage(error, 'GitHub could not sync this branch for another reason')}; forced upstream reset failed: ${fallbackError.message}`;
            return { status, message, sourceUrl: null };
          }
        }

        status = 'blocked';
        message = `Blocked - ${apiErrorMessage(error, 'GitHub could not sync this branch for another reason')}`;
      } else if (error.status === 403) {
        message = 'Forbidden - insufficient permissions or rate limited';
      } else if (error.status === 404) {
        message = 'Repository not found or not a fork';
      }
    }

    return { status, message, sourceUrl: null };
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

function writeOutputs({ results, total, successCount, failedCount, blockedCount, skippedCount }) {
  writeResultsFile(results);
  setOutput('summary-file', resultsFile);
  setOutput('total', total);
  setOutput('success', successCount);
  setOutput('failed', failedCount);
  setOutput('blocked', blockedCount);
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
  console.log(`Batch size: ${maxReposPerRun}; skip successful syncs newer than ${minSyncAgeHours}h`);
  const syncState = await getPreviousSyncState();
  const forkedRepos = await getAllForks(org);
  console.log(`Found ${forkedRepos.length} forked repositories`);

  const results = [];
  let successCount = 0;
  let failedCount = 0;
  let blockedCount = 0;
  let skippedCount = 0;
  let attemptedSyncs = 0;
  const eligibleRepos = [];
  const now = Date.now();

  for (let index = 0; index < forkedRepos.length; index++) {
    const repo = forkedRepos[index];
    const skipped = skipReason(repo) || recentlySyncedReason(repo, syncState, now);

    if (skipped) {
      skippedCount++;
      console.log(`SKIPPED ${repo.nameWithOwner} (${skipped})`);
      addSkippedResult(results, repo, skipped);
      continue;
    }

    const enrichedRepo = upstreamMetadataFromState(repo, syncState, now) || await withUpstreamMetadata(repo);
    const upstreamSkipped = upstreamAwareSkipReason(enrichedRepo, syncState, now);
    if (upstreamSkipped) {
      skippedCount++;
      console.log(`SKIPPED ${enrichedRepo.nameWithOwner} (${upstreamSkipped})`);
      addSkippedResult(results, enrichedRepo, upstreamSkipped);
      continue;
    }

    const blockedSkipped = blockedSyncRetryReason(enrichedRepo, syncState, now);
    if (blockedSkipped) {
      skippedCount++;
      console.log(`SKIPPED ${enrichedRepo.nameWithOwner} (${blockedSkipped})`);
      addSkippedResult(results, enrichedRepo, blockedSkipped);
      continue;
    }

    eligibleRepos.push(enrichedRepo);
  }

  eligibleRepos.sort(byOldestSuccessfulSync(syncState, now));
  const reposToSync = eligibleRepos.slice(0, maxReposPerRun);
  const deferredRepos = eligibleRepos.slice(maxReposPerRun);

  for (const repo of deferredRepos) {
    const skipped = `Skipped - batch limit reached (max ${maxReposPerRun} per run)`;
    skippedCount++;
    console.log(`SKIPPED ${repo.nameWithOwner} (${skipped})`);
    addSkippedResult(results, repo, skipped);
  }

  console.log(`Selected ${reposToSync.length}/${eligibleRepos.length} eligible repositories for this run`);

  for (let index = 0; index < reposToSync.length; index++) {
    const repo = reposToSync[index];

    if (attemptedSyncs > 0 && syncDelayMs > 0) {
      await delay(syncDelayMs);
    }
    attemptedSyncs++;

    console.log(`[${index + 1}/${reposToSync.length}] Syncing ${repo.nameWithOwner} (${repo.defaultBranch})...`);

    const result = await syncRepo(repo.nameWithOwner, repo.defaultBranch, repo.upstreamName, repo.upstreamDefaultBranch || repo.defaultBranch);
    const status = result.status;
    console.log(`${status.toUpperCase()} ${repo.nameWithOwner}${result.message !== 'Success' ? ` (${result.message})` : ''}`);

    if (status === 'success') {
      successCount++;
    } else if (status === 'blocked') {
      blockedCount++;
    } else {
      failedCount++;
    }

    results.push({
      repo: repo.nameWithOwner,
      status,
      message: result.message,
      parent: result.sourceUrl || repo.upstreamUrl || repo.sourceUrl,
      branch: repo.defaultBranch,
      upstream: repo.upstreamName || '',
      upstreamDefaultBranch: repo.upstreamDefaultBranch || repo.defaultBranch,
      upstreamPushedAt: repo.upstreamPushedAt || null,
      upstreamCheckedAt: repo.upstreamCheckedAt || null,
      upstreamMetadataSource: repo.upstreamMetadataSource || ''
    });
  }

  writeOutputs({ results, total: forkedRepos.length, successCount, failedCount, blockedCount, skippedCount });
  console.log(`Successfully synced ${successCount}/${attemptedSyncs} attempted repositories; blocked ${blockedCount}; failed ${failedCount}; skipped ${skippedCount}`);
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
    blockedCount: 0,
    skippedCount: 0
  });
});
