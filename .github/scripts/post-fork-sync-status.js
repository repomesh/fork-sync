'use strict';

const fs = require('fs');
const zlib = require('zlib');

const REPORT_LABEL = 'fork-sync-status';
const AUTOMATED_LABEL = 'automated';
const MAX_REPOS_PER_SECTION = 200;
const MAX_BODY_LENGTH = 60000;
const STATE_PATTERN = /<!-- fork-sync-state:v1\s+([A-Za-z0-9+/=]+)\s+-->/;

function parseCount(value) {
  const count = Number(value || 0);
  return Number.isFinite(count) ? count : 0;
}

function parseSummary(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.log(`Could not parse sync summary: ${error.message}`);
    return [];
  }
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

function encodeSyncState(state) {
  const encoded = zlib.gzipSync(JSON.stringify(state)).toString('base64');
  return `<!-- fork-sync-state:v1\n${encoded}\n-->`;
}

function mergeSyncState(previousState, summary) {
  const now = new Date().toISOString();
  const repos = {};

  for (const result of summary) {
    if (!result.repo) {
      continue;
    }

    const entry = { ...(previousState.repos?.[result.repo] || {}) };
    entry.lastSeen = now;
    entry.lastStatus = result.status;
    entry.lastMessage = oneLine(result.message, 1000);
    entry.branch = result.branch || '';
    entry.parent = result.parent || '';
    entry.upstream = result.upstream || entry.upstream || '';
    entry.upstreamDefaultBranch = result.upstreamDefaultBranch || entry.upstreamDefaultBranch || result.branch || '';
    entry.upstreamPushedAt = result.upstreamPushedAt || entry.upstreamPushedAt || null;
    entry.upstreamCheckedAt = result.upstreamCheckedAt || entry.upstreamCheckedAt || null;

    if (result.status === 'success') {
      entry.lastSuccessfulSync = now;
      entry.lastSuccessfulUpstreamPushedAt = result.upstreamPushedAt || entry.lastSuccessfulUpstreamPushedAt || null;
      delete entry.lastBlockedSync;
      delete entry.lastBlockedUpstreamPushedAt;
    }

    if (result.status === 'blocked') {
      entry.lastBlockedSync = now;
      entry.lastBlockedUpstreamPushedAt = result.upstreamPushedAt || entry.lastBlockedUpstreamPushedAt || null;
    }

    repos[result.repo] = entry;
  }

  return { version: 1, updatedAt: now, repos };
}

function loadSummary() {
  const summaryFile = process.env.SUMMARY_FILE;
  if (summaryFile && fs.existsSync(summaryFile)) {
    try {
      return parseSummary(fs.readFileSync(summaryFile, 'utf8'));
    } catch (error) {
      console.log(`Could not read sync summary file: ${error.message}`);
    }
  }

  return parseSummary(process.env.SUMMARY);
}

function oneLine(value, maxLength = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function inlineCode(value) {
  return `\`${String(value || '').replace(/`/g, "'")}\``;
}

function resultLine(result, includeParent) {
  const branch = inlineCode(result.branch || 'unknown');
  const parent = includeParent && result.parent ? ` from ${result.parent}` : '';
  const message = !includeParent && result.message ? ` - ${oneLine(result.message)}` : '';

  return `- **${oneLine(result.repo || 'unknown')}** (${branch})${parent}${message}\n`;
}

function appendResults(body, title, results, includeParent) {
  if (results.length === 0) {
    return body;
  }

  body += `### ${title} (${results.length})\n`;

  for (const result of results.slice(0, MAX_REPOS_PER_SECTION)) {
    body += resultLine(result, includeParent);
  }

  if (results.length > MAX_REPOS_PER_SECTION) {
    body += `- ... ${results.length - MAX_REPOS_PER_SECTION} more repositories omitted\n`;
  }

  return `${body}\n`;
}

function trimBody(body, maxLength = MAX_BODY_LENGTH) {
  if (body.length <= maxLength) {
    return body;
  }

  return `${body.slice(0, maxLength)}\n\n_Result details truncated because the issue body reached the GitHub limit._\n`;
}

async function ensureLabel(github, repoContext, label) {
  try {
    await github.rest.issues.getLabel({
      ...repoContext,
      name: label.name
    });
  } catch (error) {
    if (error.status !== 404) {
      throw error;
    }

    await github.rest.issues.createLabel({
      ...repoContext,
      name: label.name,
      color: label.color,
      description: label.description
    });
  }
}

module.exports = async function postForkSyncStatus({ github, context }) {
  const repoContext = {
    owner: context.repo.owner,
    repo: context.repo.repo
  };

  const total = parseCount(process.env.TOTAL);
  const success = parseCount(process.env.SUCCESS);
  const failed = parseCount(process.env.FAILED);
  const blocked = parseCount(process.env.BLOCKED);
  const skipped = parseCount(process.env.SKIPPED);
  const syncResult = process.env.SYNC_RESULT || 'unknown';
  const summary = loadSummary();
  const attempted = Math.max(total - skipped, 0);
  const effectiveFailed = failed > 0 ? failed : (syncResult === 'success' ? 0 : 1);
  const successRate = attempted > 0 ? ((success / attempted) * 100).toFixed(1) : '0.0';

  let statusIcon = ':white_check_mark:';
  if (effectiveFailed > 0 || blocked > 0) {
    statusIcon = ':warning:';
  }
  if (total > 0 && effectiveFailed >= total) {
    statusIcon = ':x:';
  }

  let body = `${statusIcon} **Fork Sync Status Report**\n\n`;
  body += `**Timestamp:** ${new Date().toISOString()}\n`;
  body += `**Trigger:** ${process.env.GITHUB_EVENT_NAME === 'schedule' ? 'Scheduled' : 'Manual'}\n`;
  body += `**Workflow result:** ${syncResult}\n\n`;
  body += `**Batch size:** ${process.env.MAX_REPOS_PER_RUN || '50'}\n`;
  body += `**Sync delay:** ${process.env.SYNC_DELAY_MS || '5000'}ms\n`;
  body += `**Recent sync window:** ${process.env.MIN_SYNC_AGE_HOURS || '24'}h\n\n`;
  body += `**Blocked retry window:** ${process.env.BLOCKED_RETRY_HOURS || '168'}h\n\n`;
  body += `**Force blocked sync:** ${process.env.FORCE_BLOCKED_SYNC || 'true'}\n\n`;
  body += `## Summary\n`;
  body += `| Metric | Count |\n`;
  body += `|--------|-------|\n`;
  body += `| Total Repos | ${total} |\n`;
  body += `| Attempted | ${attempted} |\n`;
  body += `| Successful | ${success} |\n`;
  body += `| Failed | ${failed} |\n`;
  body += `| Blocked | ${blocked} |\n`;
  body += `| Skipped | ${skipped} |\n`;
  body += `| Success Rate | ${successRate}% |\n\n`;

  if (summary.length > 0) {
    const successful = summary.filter(result => result.status === 'success');
    const failedRepos = summary.filter(result => result.status === 'failed');
    const blockedRepos = summary.filter(result => result.status === 'blocked');
    const skippedRepos = summary.filter(result => result.status === 'skipped');

    body += `## Detailed Results\n`;
    body = appendResults(body, 'Successful', successful, true);
    body = appendResults(body, 'Blocked', blockedRepos, false);
    body = appendResults(body, 'Failed', failedRepos, false);
    body = appendResults(body, 'Skipped', skippedRepos, false);
  }

  body += `---\n`;
  body += `[View Workflow Run](${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID})\n`;

  await ensureLabel(github, repoContext, {
    name: REPORT_LABEL,
    color: '0e8a16',
    description: 'Automated fork synchronization status reports'
  });
  await ensureLabel(github, repoContext, {
    name: AUTOMATED_LABEL,
    color: 'ededed',
    description: 'Created by automation'
  });

  const issues = await github.rest.issues.listForRepo({
    ...repoContext,
    state: 'open',
    labels: REPORT_LABEL,
    per_page: 100
  });

  const existingIssue = issues.data.find(issue => issue.title.includes('Fork Sync Status'));
  const title = `Fork Sync Status - ${new Date().toISOString().slice(0, 10)}`;
  const previousState = decodeSyncState(existingIssue?.body);
  const nextState = mergeSyncState(previousState, summary);
  const stateComment = encodeSyncState(nextState);
  const visibleBodyBudget = Math.max(1000, MAX_BODY_LENGTH - stateComment.length - 1);
  body = `${trimBody(body, visibleBodyBudget)}\n${stateComment}`;

  if (existingIssue) {
    await github.rest.issues.update({
      ...repoContext,
      issue_number: existingIssue.number,
      title,
      body
    });
    console.log(`Updated issue #${existingIssue.number}`);
    return;
  }

  const issue = await github.rest.issues.create({
    ...repoContext,
    title,
    body,
    labels: [REPORT_LABEL, AUTOMATED_LABEL]
  });
  console.log(`Created issue #${issue.data.number}`);
};