/* =============================================================================
   Adjust → UA Terminal proxy  (Vercel-style serverless function)
   Deploy path: /api/adjust   ·   Reads token from process.env.ADJUST_API_TOKEN
   The token NEVER reaches the browser. The static dashboard fetches this endpoint.

   NOTE: Adjust metric/dimension slugs vary by API version. Validate the names
   marked "verify" against your account's current Adjust API docs and a one-row
   test pull before trusting the numbers. The shape returned here is what the
   dashboard expects; only the slug strings below may need adjusting.
   ============================================================================= */

const ADJUST_BASE = "https://automate.adjust.com/reports-service/report";
const PERIODS = [0, 1, 2, 3, 7, 14, 21, 30, 60, 90];
const isGoogle = (n) => /google|adwords/i.test(n || "");

// ---- allow your static site's origin (or "*" while testing) -----------------
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || "*";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOW_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  const token = process.env.ADJUST_API_TOKEN;
  if (!token) return res.status(500).json({ error: "ADJUST_API_TOKEN not configured" });

  const { from, to } = req.query || {};
  if (!from || !to) return res.status(400).json({ error: "from and to (YYYY-MM-DD) required" });

  try {
    const dates = dateRange(from, to);
    const units = new Map();      // key -> unit metadata
    const delivery = [];
    const cohortMap = new Map();  // "date|unitId|country" -> {rev[],ret[],size,spend}

    let nextUnitId = 0;
    const unitId = (u) => {
      const key = [u.app, u.os, u.network, u.campaign, u.adgroup, u.creativeResolved, u.country].join("|");
      if (!units.has(key)) units.set(key, { id: nextUnitId++, ...u });
      return units.get(key).id;
    };

    // Partition by day to stay under Report Service row caps (see design doc §3.3).
    // Run days with bounded concurrency so the function stays within serverless limits.
    async function processDay(day) {
      // ----- DELIVERY pull -----
      const dRows = await pull(token, {
        date_period: `${day}:${day}`,
        dimensions: "day,app,os_name,partner_name,campaign,adgroup,creative,country",
        metrics: "impressions,clicks,installs,cost",       // verify slugs
        utc_offset: "+00:00",
        currency: "USD",
      });
      for (const r of dRows) {
        const net = r.partner_name || r.partner || "Unknown";
        const creativeRaw = (r.creative || "").trim();
        const meta = {
          app: r.app || r.app_name, os: (r.os_name || "").toLowerCase(), network: net,
          campaign: r.campaign || "(none)", adgroup: r.adgroup || "(none)",
          creativeResolved: isGoogle(net) && !creativeRaw ? (r.adgroup || "(none)") : (creativeRaw || "(unknown)"),
          source: isGoogle(net) && !creativeRaw ? "adgroup_fallback" : "native",
          country: (r.country || "ZZ").toUpperCase(),
        };
        const id = unitId(meta);
        delivery.push({
          date: day, unitId: id, country: meta.country,
          impressions: num(r.impressions), clicks: num(r.clicks),
          installs: num(r.installs), spend: num(r.cost),
        });
      }

      // ----- COHORT pull (revenue + retention by period) -----
      const cRows = await pull(token, {
        date_period: `${day}:${day}`,
        dimensions: "day,app,os_name,partner_name,campaign,adgroup,creative,country",
        // cohort revenue (cumulative) + retained users per period; verify these slugs:
        metrics: PERIODS.map((p) => `revenue_total_d${p}`).join(",") + "," +
                 PERIODS.map((p) => `retained_users_d${p}`).join(",") + ",installs,cost",
        utc_offset: "+00:00",
        currency: "USD",
      });
      const maturity = Math.round((Date.now() - new Date(day + "T00:00:00Z")) / 86400000);
      for (const r of cRows) {
        const net = r.partner_name || "Unknown";
        const creativeRaw = (r.creative || "").trim();
        const meta = {
          app: r.app || r.app_name, os: (r.os_name || "").toLowerCase(), network: net,
          campaign: r.campaign || "(none)", adgroup: r.adgroup || "(none)",
          creativeResolved: isGoogle(net) && !creativeRaw ? (r.adgroup || "(none)") : (creativeRaw || "(unknown)"),
          source: isGoogle(net) && !creativeRaw ? "adgroup_fallback" : "native",
          country: (r.country || "ZZ").toUpperCase(),
        };
        const id = unitId(meta);
        cohortMap.set(`${day}|${id}|${meta.country}`, {
          date: day, unitId: id, country: meta.country,
          cohortSize: num(r.installs), spend: num(r.cost),
          rev: PERIODS.map((p) => (p > maturity ? null : num(r["revenue_total_d" + p]))),
          ret: PERIODS.map((p) => (p > maturity ? null : (p === 0 ? num(r.installs) : num(r["retained_users_d" + p])))),
        });
      }
    }

    const CONCURRENCY = 4;
    for (let i = 0; i < dates.length; i += CONCURRENCY) {
      await Promise.all(dates.slice(i, i + CONCURRENCY).map(processDay));
    }

    const payload = {
      units: [...units.values()],
      delivery,
      cohorts: [...cohortMap.values()],
    };
    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=3600");
    return res.status(200).json(payload);
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) });
  }
}

/* ---- helpers ---- */
async function pull(token, params) {
  const url = ADJUST_BASE + "?" + new URLSearchParams(params).toString();
  let attempt = 0;
  while (true) {
    const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
    if (r.status === 429 && attempt < 5) {
      const wait = parseInt(r.headers.get("Retry-After") || "5", 10);
      await new Promise((s) => setTimeout(s, wait * 1000));
      attempt++; continue;
    }
    if (!r.ok) throw new Error(`Adjust ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return j.rows || j.data || [];     // Report Service returns { rows: [...] }
  }
}
const num = (v) => (v == null || v === "" ? 0 : +v) || 0;
function dateRange(from, to) {
  const out = [], d = new Date(from + "T00:00:00Z"), end = new Date(to + "T00:00:00Z");
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
