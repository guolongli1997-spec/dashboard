/* ============================================================================
 * Tool layer - every tool hits a real upstream or says so.
 *
 *   currency      frankfurter.app, or EXCHANGE_API_KEY
 *   visa          IATA Timatic (needs IATA_API_KEY), else needs_setup
 *   flights       Amadeus (client id + secret) or Serpapi Google Flights (AMADEUS_API_KEY)
 *   hotels        Amadeus hotel offer/availability, or Serpapi Google Hotels
 *   web_search    MCP_WEB_SEARCH_URL, or any user MCP server exposing a search tool
 *   mcp/*         user-added MCP servers (JSON-RPC 2.0 over HTTP)
 *
 * A tool that is not configured returns { ok:false, status:'needs_setup' } and the
 * model is told plainly that the lookup failed - never a fabricated answer.
 * ==========================================================================*/
import { uid } from './http.js';

const UA = 'FlyDragonAI/1.0 (+https://flytripvisa.site)';
const AM_ADEUS = 'https://test.api.amadeus.com';   // overridable with AMADEUS_BASE
const AM_TOKEN_PATH = '/v1/security/oauth2/token';

function upstreamError(status, message) {
  const err = new Error(message || `upstream ${status}`);
  err.httpStatus = status >= 500 || !status ? 502 : status;
  err.code = status === 429 ? 'upstream_rate_limited' : 'upstream_error';
  return err;
}

const num = (value, lo, hi, dflt) => Math.min(hi, Math.max(lo, Number(value) || dflt));
const isoDate = (value, offsetDays = 0) => {
  const asString = String(value || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(asString)) return asString;
  return new Date(Date.now() + offsetDays * 86400000).toISOString().slice(0, 10);
};

async function fetchJson(url, { headers, body, timeout = 9000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: { 'user-agent': UA, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: typeof body === 'string' ? body : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (err) { /* keep raw below */ }
    if (!res.ok) {
      throw upstreamError(res.status, (data && (data.error_description || data.message || data.error)) || `HTTP ${res.status}`);
    }
    return data ?? { raw: text };
  } catch (err) {
    if (err?.name === 'AbortError') throw upstreamError(0, 'The lookup timed out.');
    throw err instanceof Error && err.httpStatus ? err : upstreamError(0, err?.message || 'The lookup could not reach its source.');
  } finally {
    clearTimeout(timer);
  }
}

const needSetup = (tool, what, extra = {}) => ({
  tool,
  ok: false,
  status: 'needs_setup',
  message: `${tool}: not configured yet. ${what}`,
  results: [],
  ...extra,
});

const badRequest = (tool, message) => ({ tool, ok: false, status: 'bad_request', message, results: [] });

/* ------------------------------ currency ------------------------------- */
export async function convertCurrency(env, args = {}) {
  const amount = num(args.amount, 0, 1e9, 1);
  const from = String(args.from || 'USD').toUpperCase().slice(0, 3);
  const to = String(args.to || 'BDT').toUpperCase().slice(0, 3);

  if (env.EXCHANGE_API_KEY) {
    try {
      const data = await fetchJson(`https://api.exchangerate.host/${from}?base=${from}&symbols=${to}&access_key=${env.EXCHANGE_API_KEY}`);
      const rate = Number(data?.rates?.[to]);
      if (Number.isFinite(rate)) return { tool: 'currency', ok: true, from, to, amount, rate, converted: Number((amount * rate).toFixed(4)), as_of: data.date || null, source: 'exchangerate.host' };
    } catch (err) {
      console.warn('[tools] exchangerate.host:', err.message);
    }
  }
  try {
    const data = await fetchJson(`https://api.frankfurter.app/latest?from=${from}&to=${to}`);
    const rate = Number(data?.rates?.[to]);
    if (Number.isFinite(rate)) {
      return { tool: 'currency', ok: true, from, to, amount, rate, converted: Number((amount * rate).toFixed(4)), as_of: data.date || null, source: 'frankfurter.app' };
    }
  } catch (err) {
    console.warn('[tools] frankfurter:', err.message);
  }
  return needSetup('currency', 'Set EXCHANGE_API_KEY or allow frankfurter.app egress.');
}

/* -------------------------------- visa --------------------------------- */
export async function visaRequirements(env, args = {}) {
  const passport = String(args.passport || '').toUpperCase().slice(0, 3);
  const destination = String(args.destination || '').toUpperCase().slice(0, 3);
  const purpose = String(args.purpose || 'tourism').toLowerCase().slice(0, 20);
  if (passport.length < 2 || destination.length < 2) return badRequest('visa', 'passport and destination (ISO codes) are required.');

  if (!env.IATA_API_KEY) {
    return needSetup('visa', 'Set IATA_API_KEY for live Timatic rules; the assistant will answer from its own knowledge and remind you to verify with the embassy.',
      { passport, destination, purpose });
  }
  try {
    const data = await fetchJson(
      `https://api.iata.org/timatic/responses?nationality=${passport}&destination=${destination}&purpose=${purpose}`,
      { headers: { authorization: `Bearer ${env.IATA_API_KEY}` }, timeout: 12000 },
    );
    const rules = Array.isArray(data?.Data) ? data.Data : [];
    return {
      tool: 'visa',
      ok: rules.length > 0,
      status: rules.length ? undefined : 'no_results',
      passport,
      destination,
      purpose,
      as_of: data?.Timestamp || null,
      source: 'IATA Timatic',
      results: rules.slice(0, 5).map((rule) => ({
        visa_required: Boolean(rule?.Visa?.Required),
        visa_on_arrival: Boolean(rule?.Visa?.Arrival),
        visa_free: Boolean(rule?.Visa?.Waived),
        max_stay_days: num(rule?.Visa?.Stay, 0, 100000, 0) || undefined,
        notes: String(rule?.Text?.En || rule?.Notes || '').slice(0, 900) || undefined,
      })),
    };
  } catch (err) {
    return { tool: 'visa', ok: false, status: 'failed', error: err.message, passport, destination, results: [] };
  }
}

/* --------------------------- Amadeus plumbing -------------------------- */
async function amadeusToken(env) {
  const base = env.AMADEUS_BASE || AM_ADEUS;
  const res = await fetch(`${base}${AM_TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.AMADEUS_CLIENT_ID, client_secret: env.AMADEUS_CLIENT_SECRET }).toString(),
  });
  if (!res.ok) throw upstreamError(res.status, 'Amadeus token request failed');
  const data = await res.json();
  return data.access_token;
}

async function amadeusGet(env, path, params) {
  const base = env.AMADEUS_BASE || AM_ADEUS;
  const token = await amadeusToken(env);
  return fetchJson(`${base}${path}?${params}`, { headers: { authorization: `Bearer ${token}` }, timeout: 12000 });
}

/* ------------------------------- flights ------------------------------- */
export async function flightSearch(env, args = {}) {
  const from = String(args.from || '').toUpperCase().slice(0, 3);
  const to = String(args.to || '').toUpperCase().slice(0, 3);
  const departDate = isoDate(args.departDate || args.depart_date, 7);
  const adults = num(args.adults, 1, 9, 1);
  const currency = String(args.currency || 'USD').toUpperCase().slice(0, 3);
  const limit = num(args.limit, 1, 10, 5);
  if (from.length !== 3 || to.length !== 3) return badRequest('flights', 'origin and destination IATA codes are required.');

  if (env.AMADEUS_CLIENT_ID && env.AMADEUS_CLIENT_SECRET) {
    try {
      const data = await amadeusGet(env, '/v2/shopping/flight-offers', new URLSearchParams({
        originLocationCode: from, destinationLocationCode: to, departureDate: departDate, adults: String(adults), currencyCode: currency, max: String(limit * 4), nonStop: 'false',
      }));
      const offers = Array.isArray(data?.data) ? data.data : [];
      return {
        tool: 'flights', ok: offers.length > 0, status: offers.length ? undefined : 'no_results', provider: 'amadeus', from, to, departDate, currency,
        results: offers.slice(0, limit).map((offer) => ({
          price: offer?.price?.grandTotal || offer?.price?.total || null,
          currency: offer?.price?.currency || currency,
          duration: offer?.itineraries?.[0]?.duration || null,
          legs: (offer?.itineraries?.[0]?.segments || []).map((leg) => ({
            airline: leg?.carrierCode, flight: leg?.number, from: leg?.departure?.iataCode, to: leg?.arrival?.iataCode,
            depart: leg?.departure?.at, arrive: leg?.arrival?.at,
          })),
        })),
      };
    } catch (err) {
      console.warn('[tools] amadeus flights:', err.message);
      return { tool: 'flights', ok: false, status: 'failed', error: err.message, from, to, results: [] };
    }
  }

  const serpKey = env.AMADEUS_API_KEY || env.SERPAPI_KEY;      // legacy binding: Serpapi key lived under this name
  if (serpKey) {
    try {
      const data = await fetchJson(`https://serpapi.com/search.json?${new URLSearchParams({
        engine: 'google_flights', departure_address: from, arrival_address: to, departure_date: departDate,
        adults: String(adults), currency, hl: 'en', api_key: serpKey,
      })}`, { timeout: 12000 });
      const found = Array.isArray(data?.best_flights) ? data.best_flights : [];
      return {
        tool: 'flights', ok: found.length > 0, status: found.length ? undefined : (data?.error ? 'failed' : 'no_results'),
        provider: 'google_flights', from, to, departDate, currency,
        results: found.slice(0, limit).map((flight) => ({
          price: flight?.price ?? null,
          currency,
          duration: flight?.total_duration || null,
          legs: (flight?.flights || []).map((leg) => ({
            airline: leg?.airline, flight: leg?.flight_number,
            from: leg?.departure_airport?.id, to: leg?.arrival_airport?.id,
            depart: leg?.departure_airport?.time, arrive: leg?.arrival_airport?.time,
          })),
        })),
      };
    } catch (err) {
      return { tool: 'flights', ok: false, status: 'failed', error: err.message, from, to, results: [] };
    }
  }

  return needSetup('flights', 'Set AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET, or a search API key.', { from, to, departDate });
}

/* -------------------------------- hotels ------------------------------- */
export async function hotelSearch(env, args = {}) {
  const city = String(args.city || '').trim().slice(0, 60);
  const checkIn = isoDate(args.checkIn || args.checkin_date, 1);
  const checkOut = isoDate(args.checkOut || args.checkout_date, 3);
  const adults = num(args.adults, 1, 8, 1);
  const currency = String(args.currency || 'USD').toUpperCase().slice(0, 3);
  const limit = num(args.limit, 1, 10, 6);
  if (city.length < 2) return badRequest('hotels', 'A city name is required.');

  if (env.AMADEUS_CLIENT_ID && env.AMADEUS_CLIENT_SECRET) {
    try {
      const places = await amadeusGet(env, '/v1/reference-data/locations/hotels/by-city', new URLSearchParams({
        cityCode: city.toUpperCase(), radius: '10', checkIn, checkOut, adults: String(adults),
      }));
      const ids = (places?.data || []).map((p) => p?.hotelId).filter(Boolean).slice(0, 8);
      if (!ids.length) return { tool: 'hotels', ok: true, status: 'no_results', provider: 'amadeus', city, results: [], _ids: ids };
      const offers = await amadeusGet(env, '/v3/shopping/hotel-offers', new URLSearchParams({
        hotelIds: ids.join(','), checkInDate: checkIn, checkOutDate: checkOut, adults: String(adults), currencyCode: currency, bestRateOnly: 'true',
      }));
      const list = Array.isArray(offers?.data) ? offers.data : [];
      return {
        tool: 'hotels', ok: list.length > 0, status: list.length ? undefined : 'no_results', provider: 'amadeus', city, checkIn, checkOut, currency,
        results: list.slice(0, limit).map((entry) => ({
          hotel: entry?.hotel?.name || null,
          address: entry?.hotel?.address?.line1 || null,
          pricePerNight: entry?.offered?.price?.base || entry?.offered?.price?.average || entry?.offered?.price?.total || null,
          total: entry?.offered?.price?.total || null,
          currency: entry?.offered?.price?.currency || currency,
          room: entry?.room?.typeEstimated?.category || entry?.room?.description?.text || entry?.room?.type || null,
        })),
      };
    } catch (err) {
      console.warn('[tools] amadeus hotels:', err.message);
      return { tool: 'hotels', ok: false, status: 'failed', error: err.message, city, results: [] };
    }
  }

  const serpKey = env.SERPAPI_KEY || env.AMADEUS_API_KEY;
  if (serpKey) {
    try {
      const data = await fetchJson(`https://serpapi.com/search.json?${new URLSearchParams({
        engine: 'google_hotels', query: `hotels in ${city}`, checkin_date: checkIn, checkout_date: checkOut,
        adults: String(adults), currency, hl: 'en', api_key: serpKey,
      })}`, { timeout: 12000 });
      const properties = Array.isArray(data?.properties) ? data.properties : [];
      return {
        tool: 'hotels', ok: properties.length > 0, status: properties.length ? undefined : 'no_results', provider: 'google_hotels', city, checkIn, checkOut, currency,
        results: properties.slice(0, limit).map((p) => ({
          hotel: p?.name || null,
          address: p?.address || null,
          pricePerNight: p?.price || null,
          rating: p?.rating ?? null,
          currency,
        })),
      };
    } catch (err) {
      return { tool: 'hotels', ok: false, status: 'failed', error: err.message, city, results: [] };
    }
  }

  return needSetup('hotels', 'Set AMADEUS_CLIENT_ID + AMADEUS_CLIENT_SECRET, or a search API key.', { city, checkIn, checkOut });
}

/* ----------------------------- web search ------------------------------ */
export async function webSearch(env, args = {}, mcpServers = []) {
  const query = String(args.query || '').trim().slice(0, 300);
  const limit = num(args.limit, 1, 10, 5);
  if (query.length < 2) return badRequest('web_search', 'A query string is required.');

  if (env.MCP_WEB_SEARCH_URL) {
    try {
      const data = await fetchJson(`${env.MCP_WEB_SEARCH_URL}?${new URLSearchParams({ q: query, limit: String(limit) })}`, {
        headers: env.MCP_WEB_SEARCH_KEY ? { authorization: `Bearer ${env.MCP_WEB_SEARCH_KEY}` } : undefined,
        timeout: 12000,
      });
      return normalizeSearch(data, query, limit, 'configured search endpoint');
    } catch (err) {
      console.warn('[tools] web search endpoint failed:', err.message);
    }
  }

  for (const server of mcpServers) {
    const found = server.tools?.find?.((tool) => /search/i.test(tool.name || ''));
    if (!found) continue;
    try {
      const text = await callMcpTool(server, found.name, { query, limit }, cspTimeout(args));
      return { tool: 'web_search', ok: Boolean(text), query, source: `mcp:${server.name}`, results: [{ snippet: String(text).slice(0, 2000) }] };
    } catch (err) {
      console.warn(`[tools] mcp ${server.name} search failed:`, err.message);
    }
  }

  const perplexity = env.PARALLEL_API_KEY || env.PERPLEXITY_API_KEY;
  if (perplexity) {
    try {
      const data = await fetchJson('https://api.perplexity.ai/chat/completions', {
        headers: { authorization: `Bearer ${perplexity}` },
        body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: `Return the top ${limit} live web results for: ${query}. Respond as JSON with a results array of {title,url,snippet}.` }] }),
        timeout: 20000,
      });
      const content = data?.choices?.[0]?.message?.content || '';
      let parsed = null;
      try { parsed = JSON.parse(String(content).replace(/^```json\s*|```$/g, '')); } catch (err) { /* fall through */ }
      if (parsed) return normalizeSearch(parsed, query, limit, 'perplexity sonar');
      return { tool: 'web_search', ok: true, query, source: 'perplexity sonar', results: [{ snippet: String(content).slice(0, 2000) }] };
    } catch (err) {
      console.warn('[tools] perplexity search failed:', err.message);
    }
  }

  return needSetup('web_search', 'Set MCP_WEB_SEARCH_URL, add an MCP server with a search tool, or set PARALLEL_API_KEY.', { query });
}

function cspTimeout(args) {
  return typeof args?.timeout === 'number' ? Math.min(60000, Math.max(2000, args.timeout)) : 20000;
}

function normalizeSearch(data, query, limit, source) {
  const items = Array.isArray(data?.results) ? data.results : Array.isArray(data?.choices) ? data.choices : Array.isArray(data) ? data : [];
  const results = items.slice(0, limit).map((item) => ({
    title: String(item?.title || item?.name || '').slice(0, 200) || undefined,
    url: String(item?.url || item?.link || '').slice(0, 500) || undefined,
    snippet: String(item?.snippet || item?.description || item?.content || '').slice(0, 700) || undefined,
  })).filter((item) => item.url || item.snippet);
  return { tool: 'web_search', ok: results.length > 0, status: results.length ? undefined : 'no_results', query, source, results };
}

/* ------------------------------- MCP ---------------------------------- */
const MCP_TIMEOUT = 12000;

async function mcpRequest(server, payload, timeout = MCP_TIMEOUT) {
  const res = await fetch(server.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': UA,
      ...(server.apiKey ? { authorization: `Bearer ${server.apiKey}` } : {}),
      ...(server.sessionId ? { 'mcp-session-id': server.sessionId } : {}),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeout),
  });
  const session = res.headers.get('mcp-session-id') || server.sessionId || null;
  if (res.status === 401 || res.status === 403) {
    return { ok: false, status: 'failed', error: `The server refused us (HTTP ${res.status}). Check the API key.`, session };
  }
  if (!res.ok) return { ok: false, status: 'failed', error: `HTTP ${res.status} from the MCP server`, session };
  const parsed = await readJsonRpc(res);
  if (parsed?.error) return { ok: false, status: 'failed', error: String(parsed.error.message || 'MCP protocol error'), session };
  return { ok: true, status: 'connected', result: parsed?.result ?? parsed, session };
}

async function readJsonRpc(res) {
  const text = await res.text();
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed); } catch (err) { /* SSE below */ }
  }
  for (const line of trimmed.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const frame = JSON.parse(line.slice(5).trim());
      if (frame && (frame.result || frame.error || frame.method)) return frame;
    } catch (err) { /* keep scanning */ }
  }
  return null;
}

/** Handshake + tools/list. Returns { ok, status, tools, serverName, error, sessionId }. */
export async function discoverMcp(server) {
  try {
    const init = await mcpRequest(server, {
      jsonrpc: '2.0', id: uid('mcp'), method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fly-dragon-ai', version: '1.0.0' } },
    });
    if (!init.ok) return { ok: false, status: 'failed', error: init.error, tools: [], sessionId: init.session };

    await mcpRequest({ ...server, sessionId: init.session }, { jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    const listed = await mcpRequest({ ...server, sessionId: init.session }, { jsonrpc: '2.0', id: uid('mcp'), method: 'tools/list', params: {} });
    if (!listed.ok) return { ok: false, status: 'failed', error: listed.error, tools: [], sessionId: listed.session };

    const tools = Array.isArray(listed.result?.tools) ? listed.result.tools : [];
    return {
      ok: true,
      status: 'connected',
      serverName: listed.result?.serverInfo?.name || null,
      sessionId: listed.session,
      tools: tools.slice(0, 30).map((tool) => ({
        name: String(tool?.name || '').slice(0, 60),
        description: String(tool?.description || '').slice(0, 400),
        inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : { type: 'object', properties: {} },
      })).filter((tool) => tool.name),
    };
  } catch (err) {
    const timedOut = String(err?.name) === 'TimeoutError' || String(err?.name) === 'AbortError';
    return { ok: false, status: 'failed', error: timedOut ? 'The MCP server did not answer in time.' : (err?.message || 'Unreachable MCP server.'), tools: [] };
  }
}

export async function callMcpTool(server, toolName, args, timeout = 20000) {
  const answer = await mcpRequest({ ...server }, {
    jsonrpc: '2.0', id: uid('mcp'), method: 'tools/call', params: { name: toolName, arguments: args || {} },
  }, timeout);
  if (!answer.ok) throw new Error(answer.error);
  const content = Array.isArray(answer.result?.content) ? answer.result.content : [];
  const text = content.filter((part) => part && part.type === 'text').map((part) => String(part.text ?? '')).join('\n').trim();
  return text || JSON.stringify(answer.result ?? {}).slice(0, 3000);
}

/* ------------------------------ registry ------------------------------- */
/**
 * Model-callable tools, filtered by the user's toggles (§6B). MCP tools from the
 * user's own servers are appended so a connected server is actually usable.
 */
export function buildToolset(env, prefs = {}, mcpServers = []) {
  const registry = [
    {
      key: 'visa', name: 'visa',
      description: 'Check visa requirements for a passport country travelling to a destination country.',
      parameters: { type: 'object', properties: { passport: { type: 'string', description: 'ISO-3166 alpha-3 of the passport country, e.g. BGD' }, destination: { type: 'string', description: 'ISO-3166 alpha-3 of the destination, e.g. JPN' }, purpose: { type: 'string', description: 'tourism | business | study | work | transit' } }, required: ['passport', 'destination'] },
      run: (args) => visaRequirements(env, args),
    },
    {
      key: 'flights', name: 'flights',
      description: 'Search live flight offers between two airports.',
      parameters: { type: 'object', properties: { from: { type: 'string', description: 'IATA origin, e.g. DAC' }, to: { type: 'string', description: 'IATA destination, e.g. CPT' }, departDate: { type: 'string', description: 'YYYY-MM-DD' }, adults: { type: 'number' }, currency: { type: 'string' } }, required: ['from', 'to'] },
      run: (args) => flightSearch(env, args),
    },
    {
      key: 'hotels', name: 'hotels',
      description: 'Search live hotel prices in a city for given dates.',
      parameters: { type: 'object', properties: { city: { type: 'string' }, checkIn: { type: 'string', description: 'YYYY-MM-DD' }, checkOut: { type: 'string', description: 'YYYY-MM-DD' }, adults: { type: 'number' }, currency: { type: 'string' } }, required: ['city'] },
      run: (args) => hotelSearch(env, args),
    },
    {
      key: 'currency', name: 'currency',
      description: 'Convert an amount between two currencies at today’s rate.',
      parameters: { type: 'object', properties: { amount: { type: 'number' }, from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] },
      run: (args) => convertCurrency(env, args),
    },
    {
      key: 'web_search', name: 'web_search',
      description: 'Search the live web for pages that the model cannot know (prices, rules, openings).',
      parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
      run: (args) => webSearch(env, args, mcpServers),
    },
  ];

  const chosen = registry.filter((tool) => prefs[tool.key] !== false);

  const dynamic = [];
  // enabledMcpServers() already returns only servers whose handshake succeeded, and
  // attaches their discovered tools - no second status check here, or MCP tools
  // would never reach the model.
  for (const server of mcpServers) {
    for (const tool of server.tools || []) {
      dynamic.push({
        key: `mcp_${server.id}`,
        name: `mcp_${tool.name}`.slice(0, 64),
        description: `[${server.name}] ${tool.description || 'External MCP tool.'}`.slice(0, 700),
        parameters: tool.inputSchema || { type: 'object', properties: {} },
        run: (args) => callMcpTool({ url: server.url, apiKey: server.apiKey, sessionId: server.sessionId }, tool.name, args)
          .then((text) => ({ tool: `mcp:${server.name}:${tool.name}`, ok: true, results: [{ snippet: text.slice(0, 4000) }] })),
      });
    }
  }

  return [...chosen, ...dynamic];
}

export const toolCatalog = () => ([
  { key: 'web_search', label: 'Web Search' },
  { key: 'flights', label: 'Flight Search' },
  { key: 'hotels', label: 'Hotel Search' },
  { key: 'visa', label: 'Visa Checker' },
  { key: 'currency', label: 'Currency Converter' },
]);
