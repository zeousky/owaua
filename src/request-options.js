import { domainToASCII } from 'node:url';

export class RequestOptionsError extends Error {
  constructor(message) { super(message); this.name = 'RequestOptionsError'; }
}

const FIELDS = new Set(['reasoningEffort', 'webDomains', 'xHandles', 'fromDate', 'toDate', 'visualSearch', 'outputFormat', 'schema', 'integrations']);
const EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const unset = value => value === undefined || value === null || value === '';

function list(value, { name, max, length, normalize }) {
  if (unset(value)) return undefined;
  if ((typeof value !== 'string' && !Array.isArray(value)) ||
      (typeof value === 'string' && value.length > length)) {
    throw new RequestOptionsError(`${name} must be a comma-separated list.`);
  }
  const entries = typeof value === 'string' ? value.split(',') : value;
  if (!entries.length) return undefined;
  if (entries.length > max) throw new RequestOptionsError(`Use at most ${max} ${name}.`);
  return [...new Set(entries.map(entry => {
    if (typeof entry !== 'string') throw new RequestOptionsError(`Use valid ${name}.`);
    return normalize(entry.trim());
  }))];
}

function domain(value) {
  // Only a hostname is accepted: URLs, paths, ports and wildcard patterns must
  // never become ambiguous or ineffective provider-side search restrictions.
  if (/[\s/\\:@?#*%]/u.test(value)) {
    throw new RequestOptionsError('Use bare web domains such as docs.x.ai, without URLs, paths, ports, or wildcards.');
  }
  const host = domainToASCII(value.toLowerCase().replace(/\.$/, ''));
  if (!host || host.length > 253 || !host.includes('.') || /^[\d.]+$/.test(host) ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new RequestOptionsError('Use bare web domains such as docs.x.ai, without URLs, paths, ports, or wildcards.');
  }
  return host;
}

function handle(value) {
  const name = value.replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_]{1,15}$/.test(name)) throw new RequestOptionsError('Use X handles with 1–15 letters, numbers, or underscores, optionally starting with @.');
  return name;
}

function date(value, name) {
  if (unset(value)) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) {
    throw new RequestOptionsError(`${name} must be a valid date in YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new RequestOptionsError(`${name} must be a valid date in YYYY-MM-DD format.`);
  }
  return value;
}

// These are request parameters, never privileged prompt text. Reject unknown or
// incompatible options before a paid request rather than silently ignoring them.
export function normalizeRequestOptions(raw = {}, { model = 'grok-4.7' } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).some(key => !FIELDS.has(key))) {
    throw new RequestOptionsError('Use the supported reasoning and search options.');
  }
  const options = {};
  if (!unset(raw.reasoningEffort)) {
    if (!EFFORTS.includes(raw.reasoningEffort)) throw new RequestOptionsError('Reasoning effort must be low, medium, high, or xhigh.');
    if (!['grok-4.5', 'grok-4.6', 'grok-4.7'].includes(model)) {
      throw new RequestOptionsError('Reasoning effort is supported here for grok-4.5, grok-4.6, and grok-4.7.');
    }
    if (model === 'grok-4.5' && raw.reasoningEffort === 'xhigh') throw new RequestOptionsError('xhigh reasoning requires grok-4.6 or grok-4.7.');
    options.reasoningEffort = raw.reasoningEffort;
  }
  const webDomains = list(raw.webDomains, { name: 'web domains', max: 5, length: 1500, normalize: domain });
  const xHandles = list(raw.xHandles, { name: 'X handles', max: 20, length: 500, normalize: handle });
  if (webDomains) options.webDomains = webDomains;
  if (xHandles) options.xHandles = xHandles;
  const fromDate = date(raw.fromDate, 'X start date');
  const toDate = date(raw.toDate, 'X end date');
  if (fromDate && toDate && fromDate >= toDate) {
    throw new RequestOptionsError('X end date is exclusive and must be after the start date. For one day, use the following day as the end date.');
  }
  if (fromDate) options.fromDate = fromDate;
  if (toDate) options.toDate = toDate;
  if (!unset(raw.visualSearch)) {
    if (typeof raw.visualSearch !== 'boolean') throw new RequestOptionsError('Visual search must be true or false.');
    options.visualSearch = raw.visualSearch;
  }
  if (!unset(raw.outputFormat)) {
    if (!['text', 'json'].includes(raw.outputFormat)) throw new RequestOptionsError('Output format must be text or json.');
    options.outputFormat = raw.outputFormat;
  }
  if (!unset(raw.schema) && options.outputFormat !== 'json') throw new RequestOptionsError('Choose JSON output to use a JSON schema.');
  if (options.outputFormat === 'json') options.schema = normalizeOutputSchema(raw.schema);
  const integrations = list(raw.integrations, { name: 'integrations', max: 3, length: 200, normalize: value => {
    const label = value.toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(label)) throw new RequestOptionsError('Use integration labels from /integrations.');
    return label;
  } });
  if (integrations) options.integrations = integrations;
  return options;
}

const OUTPUT_SCHEMA = {
  type: 'object', properties: {
    answer: { type: 'string' },
    sources: { type: 'array', items: { type: 'object', properties: {
      title: { type: 'string' }, url: { type: 'string' },
    }, required: ['title', 'url'], additionalProperties: false } },
  }, required: ['answer', 'sources'], additionalProperties: false,
};
const SCHEMA_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'];
const SCHEMA_KEYS = new Set(['type', 'title', 'description', 'properties', 'required', 'additionalProperties', 'items',
  'enum', 'const', 'anyOf', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const schemaError = () => new RequestOptionsError('Use a JSON object schema (maximum 4000 characters, 8 levels, 64 properties) with supported types, properties, required, additionalProperties, items, enum, const, anyOf, numeric bounds, or length bounds.');

// Deliberately bounded subset: no references, regexes, remote lookups or code
// generation. The same subset is enforced again on the returned JSON.
export function normalizeOutputSchema(raw) {
  if (unset(raw)) return structuredClone(OUTPUT_SCHEMA);
  let schema;
  try {
    if (typeof raw === 'string') {
      if (raw.length > 4000) throw schemaError();
      schema = JSON.parse(raw);
    } else {
      // Bot command handling validates before queuing; a second normalization
      // must accept that bounded canonical schema without trusting its shape.
      if (!object(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw schemaError();
      const serialized = JSON.stringify(raw);
      if (serialized.length > 8000) throw schemaError();
      schema = JSON.parse(serialized);
    }
  } catch { throw schemaError(); }
  let nodes = 0;
  const visit = (node, depth) => {
    if (!object(node) || depth > 8 || ++nodes > 128 || Object.keys(node).some(key => !SCHEMA_KEYS.has(key))) throw schemaError();
    if (node.type !== undefined && !(SCHEMA_TYPES.includes(node.type) || (Array.isArray(node.type) && node.type.length > 0 && node.type.length <= 7 && new Set(node.type).size === node.type.length && node.type.every(type => SCHEMA_TYPES.includes(type))))) throw schemaError();
    for (const key of ['title', 'description']) if (node[key] !== undefined && (typeof node[key] !== 'string' || node[key].length > 1000)) throw schemaError();
    if (!node.type && !node.anyOf && !Object.hasOwn(node, 'const') && !node.enum) throw schemaError();
    if (node.anyOf !== undefined) {
      if (!Array.isArray(node.anyOf) || node.anyOf.length < 1 || node.anyOf.length > 8) throw schemaError();
      node.anyOf.forEach(sub => visit(sub, depth + 1));
    }
    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length || node.enum.length > 64 ||
      node.enum.some(value => object(value) || Array.isArray(value) || typeof value === 'number' && !Number.isFinite(value)) ||
      new Set(node.enum.map(value => JSON.stringify(value))).size !== node.enum.length)) throw schemaError();
    if (Object.hasOwn(node, 'const') && (object(node.const) || Array.isArray(node.const) || typeof node.const === 'number' && !Number.isFinite(node.const))) throw schemaError();
    if (node.properties !== undefined) {
      if (!object(node.properties) || Object.keys(node.properties).length > 64 || Object.keys(node.properties).some(key => key.length > 100)) throw schemaError();
      Object.values(node.properties).forEach(sub => visit(sub, depth + 1));
    }
    if (node.required !== undefined && (!Array.isArray(node.required) || node.required.length > 64 ||
      node.required.some(key => typeof key !== 'string' || !Object.hasOwn(node.properties ?? {}, key)) || new Set(node.required).size !== node.required.length)) throw schemaError();
    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== 'boolean') throw schemaError();
    if (node.type === 'object' || node.type?.includes?.('object')) node.additionalProperties ??= false;
    if (node.items !== undefined) visit(node.items, depth + 1);
    if ((node.type === 'array' || node.type?.includes?.('array')) && !node.items) throw schemaError();
    for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum']) if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]))) throw schemaError();
    for (const [min, max, limit] of [['minLength', 'maxLength', 2048], ['minItems', 'maxItems', 256]]) {
      for (const key of [min, max]) if (node[key] !== undefined && (!Number.isInteger(node[key]) || node[key] < 0 || node[key] > limit)) throw schemaError();
      if (node[min] !== undefined && node[max] !== undefined && node[min] > node[max]) throw schemaError();
    }
    if (node.minimum !== undefined && node.maximum !== undefined && node.minimum > node.maximum) throw schemaError();
    if (node.exclusiveMinimum !== undefined && node.maximum !== undefined && node.exclusiveMinimum >= node.maximum ||
      node.minimum !== undefined && node.exclusiveMaximum !== undefined && node.minimum >= node.exclusiveMaximum ||
      node.exclusiveMinimum !== undefined && node.exclusiveMaximum !== undefined && node.exclusiveMinimum >= node.exclusiveMaximum) throw schemaError();
  };
  visit(schema, 0);
  if (schema.type !== 'object') throw schemaError();
  return schema;
}

export function matchesOutputSchema(value, schema) {
  const matchType = type => type === 'null' ? value === null : type === 'object' ? object(value) : type === 'array' ? Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value) : type === 'number' ? typeof value === 'number' && Number.isFinite(value) : typeof value === type;
  if (schema.type && !(Array.isArray(schema.type) ? schema.type : [schema.type]).some(matchType)) return false;
  if (schema.anyOf && !schema.anyOf.some(sub => matchesOutputSchema(value, sub))) return false;
  if (schema.enum && !schema.enum.some(entry => Object.is(entry, value))) return false;
  if (Object.hasOwn(schema, 'const') && !Object.is(schema.const, value)) return false;
  if (object(value)) {
    if ((schema.required ?? []).some(key => !Object.hasOwn(value, key))) return false;
    if (schema.additionalProperties === false && Object.keys(value).some(key => !Object.hasOwn(schema.properties ?? {}, key))) return false;
    for (const [key, sub] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key) && !matchesOutputSchema(value[key], sub)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(entry => matchesOutputSchema(entry, schema.items))) return false;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (schema.minLength !== undefined && length < schema.minLength || schema.maxLength !== undefined && length > schema.maxLength) return false;
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum ||
      schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum || schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) return false;
  }
  return true;
}

export function normalizeKnowledgeTools(tools = []) {
  if (!Array.isArray(tools) || tools.length > 1) throw new RequestOptionsError('Invalid knowledge search configuration.');
  return tools.map(tool => {
    if (!object(tool) || Object.keys(tool).sort().join(',') !== 'type,vector_store_ids' || tool.type !== 'file_search' ||
      !Array.isArray(tool.vector_store_ids) || !tool.vector_store_ids.length || tool.vector_store_ids.length > 10 ||
      tool.vector_store_ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(id))) throw new RequestOptionsError('Invalid knowledge search configuration.');
    return { type: 'file_search', vector_store_ids: [...new Set(tool.vector_store_ids)] };
  });
}

export function hostedTools(options = {}) {
  const web = { type: 'web_search' };
  const x = { type: 'x_search' };
  if (options.webDomains) web.allowed_domains = [...options.webDomains];
  if (options.xHandles) x.allowed_x_handles = [...options.xHandles];
  if (options.fromDate) x.from_date = options.fromDate;
  if (options.toDate) x.to_date = options.toDate;
  if (options.visualSearch) {
    web.enable_image_search = true;
    web.enable_image_understanding = true;
    x.enable_image_understanding = true;
    x.enable_video_understanding = true;
  }
  return [web, x, { type: 'code_interpreter' }];
}

export function opaqueRequestHash(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new RequestOptionsError(`${name} must be an opaque SHA-256 hash.`);
  }
  return value.toLowerCase();
}
