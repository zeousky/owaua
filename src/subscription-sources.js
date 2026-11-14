import { createHash } from 'node:crypto';
import { SaxesParser } from 'saxes';
import { assertSafeText, SafetyError } from './safety.js';
import { publicURL, PublicURLError } from './subscription-http.js';

export const GITHUB_API = 'https://api.github.com';
export const GITHUB_EVENTS = [
  { name: 'Everything', value: 'all' }, { name: 'Commits', value: 'commits' },
  { name: 'Releases', value: 'releases' }, { name: 'Issues', value: 'issues' },
  { name: 'Pull requests', value: 'pulls' },
];

export function githubRepository(input) {
  const match = /^(?:https:\/\/github\.com\/)?([a-z\d](?:[a-z\d-]{0,37}[a-z\d])?)\/([a-z\d_.-]{1,100})\/?$/i.exec(input.trim());
  const repo = match?.[2]?.replace(/\.git$/i, '');
  if (!repo || repo === '.' || repo === '..') throw new PublicURLError('Enter a public repository as owner/repository.');
  return `${match[1]}/${repo}`.toLowerCase();
}

function safeTitle(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const title = [...value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()].slice(0, 180).join('');
  if (!title) return fallback;
  try { assertSafeText(title); } catch (error) {
    if (error instanceof SafetyError) return fallback;
    throw error;
  }
  // Prevent a remotely supplied title from creating links or special Discord
  // formatting. The only clickable link is the checked item URL.
  return title.replace(/https?:\/\/\S+/gi, '[link]')
    .replace(/[\\`*_~|[\]<>#@]/g, char => `\\${char}`);
}

function safeLink(value, base, origin) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = publicURL(new URL(value.trim(), base));
    if (!origin || url.origin === origin) return url.href;
  } catch (error) {
    if (!(error instanceof PublicURLError || error instanceof TypeError)) throw error;
  }
}

const sourceId = value => createHash('sha256').update(value).digest('hex');

export function feedItems(xml, source) {
  const parser = new SaxesParser({ xmlns: true });
  const fields = new Set(['id', 'guid', 'title', 'link']);
  let depth = 0, root, entry, entryDepth, field;
  const entries = [];
  parser.on('doctype', () => { throw new Error('Feed declarations are unsupported.'); });
  parser.on('opentag', node => {
    if (++depth > 64) throw new Error('Feed nests too deeply.');
    if (depth === 1) root = node.local.toLowerCase();
    if (!entry && ((root === 'feed' && depth === 2 && node.local === 'entry') ||
        ((root === 'rss' || root === 'rdf') && depth <= 3 && node.local === 'item'))) {
      entry = {};
      entryDepth = depth;
      return;
    }
    if (!entry || depth !== entryDepth + 1 || !fields.has(node.local)) return;
    if (node.local === 'link' && 'href' in node.attributes) {
      const rel = node.attributes.rel?.value;
      if (!rel || rel === 'alternate') entry.link ??= node.attributes.href.value;
    } else if (!(node.local in entry)) {
      field = node.local;
      entry[field] = '';
    }
  });
  function capture(text) {
    if (field) entry[field] = (entry[field] + text.slice(0, 1200)).slice(0, 1200);
  }
  parser.on('text', capture);
  parser.on('cdata', capture);
  parser.on('closetag', () => {
    if (entry && depth === entryDepth + 1) field = undefined;
    if (entry && depth === entryDepth) {
      const { id, guid, title, link } = entry;
      const identity = [id, guid, link, title].find(part => part?.trim());
      if (identity && entries.length < 100) {
        entries.push({
          key: sourceId(identity.trim()), title: safeTitle(title, 'New feed item'),
          url: safeLink(link, source),
        });
      }
      entry = undefined;
    }
    depth--;
  });
  parser.write(xml).close();
  if (!['feed', 'rss', 'rdf'].includes(root)) throw new Error('Supply an RSS or Atom feed URL.');
  return entries;
}

export function githubItems(body, repository, selected) {
  const events = JSON.parse(body);
  if (!Array.isArray(events)) throw new Error('Unexpected GitHub response.');
  const items = [];
  for (const event of events) {
    if (!event?.public || typeof event.id !== 'string') continue;
    const target = String(event.repo?.name || repository);
    const repo = /^([a-z\d-]{1,39})\/([a-z\d_.-]{1,100})$/i.test(target) && !target.endsWith('/..') && !target.endsWith('/.')
      ? target : repository;
    const base = `https://github.com/${repo}`;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') continue;
    let kind, title, href;
    switch (event.type) {
      case 'PushEvent': {
        if (!/^refs\/heads\//.test(payload.ref) || !/^[a-f\d]{40}$/i.test(payload.head) || /^0+$/.test(payload.head)) continue;
        kind = 'commits';
        const branch = safeTitle(payload.ref.slice(11), 'branch');
        title = `New commits on ${branch} (${payload.head.slice(0, 7)})`;
        href = /^[a-f\d]{40}$/i.test(payload.before) && !/^0+$/.test(payload.before)
          ? `${base}/compare/${payload.before}...${payload.head}` : `${base}/commit/${payload.head}`;
        break;
      }
      case 'ReleaseEvent':
        if (payload.action !== 'published') continue;
        kind = 'releases';
        title = `Release · ${safeTitle(payload.release?.name || payload.release?.tag_name, 'New release')}`;
        href = payload.release?.html_url ?? `${base}/releases`;
        break;
      case 'IssuesEvent':
        if (!['opened', 'reopened', 'closed'].includes(payload.action) || !Number.isSafeInteger(payload.issue?.number)) continue;
        kind = 'issues';
        title = `Issue #${payload.issue.number} ${payload.action} · ${safeTitle(payload.issue.title, 'Issue')}`;
        href = `${base}/issues/${payload.issue.number}`;
        break;
      case 'PullRequestEvent':
        if (!['opened', 'reopened', 'closed', 'merged'].includes(payload.action) || !Number.isSafeInteger(payload.number)) continue;
        kind = 'pulls';
        title = `PR #${payload.number} ${payload.pull_request?.merged ? 'merged' : payload.action} · ${safeTitle(payload.pull_request?.title, 'Pull request')}`;
        href = `${base}/pull/${payload.number}`;
        break;
      default: continue;
    }
    if (selected !== 'all' && selected !== kind) continue;
    items.push({ key: sourceId(event.id), title, url: safeLink(href, base, 'https://github.com') });
  }
  return items;
}
