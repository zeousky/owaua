import { lookup } from 'node:dns/promises';
import { request as requestHTTP } from 'node:http';
import { request as requestHTTPS } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { assertSafeText, SafetyError } from './safety.js';

const globalIPv6 = ipaddr.parseCIDR('2000::/3');
const specialIPv6 = ipaddr.parseCIDR('2001::/23');
const localSuffix = /(?:^|\.)(?:localhost|local|internal|home\.arpa|onion|example|invalid|test|lan)$/i;
const hostnamePattern = /^(?=.{1,253}$)(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export class PublicURLError extends Error {}

export function publicAddress(address) {
  // Azure's host platform address is reserved inside its virtual networks.
  if (!isIP(address) || address.includes('%') || address === '168.63.129.16') return false;
  const ip = ipaddr.parse(address);
  if (ip.range() !== 'unicast') return false;
  return ip.kind() === 'ipv4' || (ip.match(globalIPv6) && !ip.match(specialIPv6));
}

export function publicURL(input, { allowQuery = false } = {}) {
  let url;
  try { url = new URL(input); } catch { throw new PublicURLError('Enter a complete public HTTP or HTTPS URL.'); }
  if (url.href.length > 800 || !['http:', 'https:'].includes(url.protocol) || url.port ||
      url.username || url.password || (!allowQuery && url.search)) {
    throw new PublicURLError('Use a public HTTP or HTTPS URL with a standard port and no credentials or query parameters.');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const domain = host.replace(/\.$/, '');
  if (isIP(host) ? !publicAddress(host) : (!hostnamePattern.test(domain) || localSuffix.test(domain))) {
    throw new PublicURLError('Use a publicly reachable website address.');
  }
  url.hash = '';
  try { assertSafeText(url.href); }
  catch (error) {
    if (error instanceof SafetyError) throw new PublicURLError('The address contains text Owaua cannot use.');
    throw error;
  }
  return url;
}

// DNS may return results after an abort because getaddrinfo is not cancellable.
// The abort race ensures those results cannot open a connection later.
async function resolvePublic(host, signal, resolve) {
  if (isIP(host)) return { address: host, family: isIP(host) };
  const { promise, reject } = Promise.withResolvers();
  const abort = () => reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const addresses = await Promise.race([resolve(host, { all: true, order: 'verbatim' }), promise]);
    if (!addresses.length || !addresses.every(({ address, family }) => family === isIP(address) && publicAddress(address))) {
      throw new PublicURLError('Use a website that resolves exclusively to public addresses.');
    }
    return addresses.find(result => result.family === 4) ?? addresses[0];
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

function requestOnce(url, address, { signal, headers, statusOnly, maxBytes }) {
  return new Promise((resolve, reject) => {
    const request = url.protocol === 'https:' ? requestHTTPS : requestHTTP;
    const req = request(url, {
      method: 'GET', headers, signal, agent: false, autoSelectFamily: false, rejectUnauthorized: true,
      // Each request gets a new socket and connects only to the address we just
      // validated. Keep the original host for TLS validation, SNI and HTTP Host.
      lookup: (_name, options, callback) => options.all
        ? callback(null, [address]) : callback(null, address.address, address.family),
      maxHeaderSize: 16_384,
    }, response => {
      const status = response.statusCode;
      response.on('error', reject);
      if (statusOnly || status < 200 || status >= 300) {
        resolve({ status, headers: response.headers, body: '' });
        response.destroy();
        return;
      }
      const encoding = response.headers['content-encoding']?.toLowerCase();
      if ((encoding && encoding !== 'identity') || Number(response.headers['content-length']) > maxBytes) {
        response.destroy(new Error('Unsupported or oversized website response.'));
        return;
      }
      let size = 0;
      const chunks = [];
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) response.destroy(new Error('Website response is too large.'));
        else chunks.push(chunk);
      });
      response.on('end', () => {
        resolve({ status, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Direct GETs with a deadline across DNS, redirects, connect and body. Caller
// supplied locations cannot supply headers, cookies, methods or proxy settings.
export async function fetchPublic(input, {
  signal, statusOnly = false, fixedOrigin, etag, timeoutMs = 8000, maxBytes = 1_048_576,
  resolve = lookup, request = requestOnce,
} = {}) {
  const deadline = AbortSignal.timeout(timeoutMs);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let url = publicURL(input, { allowQuery: !!fixedOrigin });
  const headers = {
    'User-Agent': 'Owaua-Discord-Notifications/1.0',
    'Accept-Encoding': 'identity',
    Accept: fixedOrigin ? 'application/vnd.github+json' : 'application/rss+xml, application/atom+xml, application/xml, */*',
    ...(fixedOrigin ? { 'X-GitHub-Api-Version': '2022-11-28' } : {}),
    ...(etag ? { 'If-None-Match': etag } : {}),
  };
  for (let hop = 0; hop <= 3; hop++) {
    signal.throwIfAborted();
    if (fixedOrigin && url.origin !== fixedOrigin) throw new PublicURLError('This source redirected off its provider.');
    const address = await resolvePublic(url.hostname.replace(/^\[|\]$/g, ''), signal, resolve);
    signal.throwIfAborted();
    const result = await request(url, address, { signal, headers, statusOnly, maxBytes });
    if (!redirectStatuses.has(result.status) || !result.headers.location) return { ...result, url: url.href };
    if (hop < 3) {
      const location = publicURL(new URL(result.headers.location, url), { allowQuery: !!fixedOrigin });
      if (url.protocol === 'https:' && location.protocol === 'http:') throw new PublicURLError('The website redirected to an insecure address.');
      url = location;
      delete headers['If-None-Match'];
    }
  }
  throw new PublicURLError('The website redirected too many times.');
}
