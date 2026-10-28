/* Network helper for the contract check: one retry for transient failures.

   The nightly run reaches DNR/USGS from GitHub's runners, where a single slow
   or 5xx answer used to turn the whole run red (and email the owner). A retry
   absorbs a one-off blip; a real contract break fails both attempts and still
   fails the run. */

// A response worth a second try: server error, or ArcGIS's in-body error
// ("Failed to execute query" arrives as HTTP 200 with {error:{code:400}}).
export function isTransient(res) {
  return res.status >= 500 || !!(res.body && res.body.error);
}

export async function getJson(url, opts = {}) {
  const { ms = 45000, retries = 1, delayMs = 2000, fetchImpl = fetch } = opts;
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetchImpl(url, { signal: ctl.signal, headers: { 'User-Agent': 'fishing-advisor-contract-check' } });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch (e) { /* not JSON */ }
      const res = { status: r.status, body, text };
      if (attempt < retries && isTransient(res)) { await sleep(delayMs); continue; }
      return res;
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(delayMs);
    } finally { clearTimeout(t); }
  }
}

// Same retry rule for a plain GET where only status and headers matter.
export async function getHead(url, opts = {}) {
  const { ms = 45000, retries = 1, delayMs = 2000, fetchImpl = fetch } = opts;
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetchImpl(url, { method: 'GET', signal: ctl.signal });
      if (attempt < retries && r.status >= 500) { await sleep(delayMs); continue; }
      return r;
    } catch (e) {
      if (attempt >= retries) throw e;
      await sleep(delayMs);
    } finally { clearTimeout(t); }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
