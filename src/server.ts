import "dotenv/config";
import Fastify from "fastify";
import { z } from "zod";
import { request } from "undici";

const PORT = Number(process.env.PORT ?? 3000);
const EM_AUTH_TOKEN = process.env.EM_AUTH_TOKEN!;
const USE_LATLON = /^true$/i.test(process.env.USE_LATLON ?? "");
const EM_ZONE = process.env.EM_ZONE ?? "AT";
const EM_LAT = Number(process.env.EM_LAT ?? 48.2);
const EM_LON = Number(process.env.EM_LON ?? 16.37);

// Simple In-Memory Cache (1h TTL) – reduziert API-Calls
type CacheEntry<T> = { until: number; data: T };
const cache = new Map<string, CacheEntry<any>>();
const ttlMs = 60 * 60 * 1000;

function setCache<T>(key: string, data: T) {
  cache.set(key, { until: Date.now() + ttlMs, data });
}
function getCache<T>(key: string): T | undefined {
  const c = cache.get(key);
  if (!c) return;
  if (Date.now() > c.until) {
    cache.delete(key);
    return;
  }
  return c.data as T;
}

const fastify = Fastify({ logger: true });

/**
 * Helper: baut Query für Electricity Maps
 */
function emQuery(params?: Record<string, string | number | boolean>) {
  const q = new URLSearchParams();
  if (USE_LATLON) {
    q.set("lat", String(EM_LAT));
    q.set("lon", String(EM_LON));
  } else {
    q.set("zone", EM_ZONE);
  }
  if (params) {
    for (const [k, v] of Object.entries(params)) q.set(k, String(v));
  }
  return q.toString();
}

/**
 * Helper: ruft Electricity Maps API
 */
async function emFetch<T>(
  path: string,
  params?: Record<string, any>
): Promise<T> {
  const qs = emQuery(params);
  const url = `https://api.electricitymap.org${path}?${qs}`;
  const cacheKey = `${path}?${qs}`;

  const cached = getCache<T>(cacheKey);
  if (cached) return cached;

  const res = await request(url, {
    method: "GET",
    headers: { "auth-token": EM_AUTH_TOKEN },
  });
  if (res.statusCode >= 400) {
    const body = await res.body.text();
    throw new Error(`EM ${res.statusCode}: ${body}`);
  }
  const data = (await res.body.json()) as T;
  setCache(cacheKey, data);
  return data;
}

/**
 * GET /co2/latest
 * Liefert aktuelle CO2-Intensität (kgCO2/kWh) + Rohdaten
 */
fastify.get("/co2/latest", async () => {
  // laut Doku: Werte in gCO2eq/kWh → wir liefern zusätzlich kgCO2/kWh
  const data = await emFetch<{ carbonIntensity: number; updatedAt: string }>(
    "/v3/carbon-intensity/latest"
  );
  const kgPerKWh = data.carbonIntensity / 1000; // g → kg
  return {
    kgCO2_per_kWh: kgPerKWh,
    raw: data,
  };
});

/**
 * GET /co2/history?hours=24
 * Liefert Verlauf (standard: 24h) und Summaries
 */
fastify.get("/co2/history", async (req) => {
  const schema = z.object({
    hours: z.coerce.number().min(1).max(168).default(24),
  });
  const { hours } = schema.parse((req as any).query);

  const data = await emFetch<{
    history: Array<{ carbonIntensity: number; datetime: string }>;
  }>("/v3/carbon-intensity/history", { pastHours: hours });

  const points = data.history.map((p) => ({
    datetime: p.datetime,
    gCO2_per_kWh: p.carbonIntensity,
    kgCO2_per_kWh: p.carbonIntensity / 1000,
  }));

  const avg_g = points.reduce((a, b) => a + b.gCO2_per_kWh, 0) / points.length;
  return {
    count: points.length,
    avg_kgCO2_per_kWh: avg_g / 1000,
    points,
  };
});

/**
 * POST /calc/wp
 * Body: { kWh: number } → berechnet CO2 der WP (kWh * aktueller Faktor)
 */
fastify.post("/calc/wp", async (req, rep) => {
  const body = await (req as any).body;
  const schema = z.object({ kWh: z.number().positive() });
  const { kWh } = schema.parse(body);

  const latest = await emFetch<{ carbonIntensity: number; updatedAt: string }>(
    "/v3/carbon-intensity/latest"
  );
  const factorKg = latest.carbonIntensity / 1000;
  const co2Kg = kWh * factorKg;

  return rep.send({
    input: { kWh },
    factor_kgCO2_per_kWh: factorKg,
    co2_kg: co2Kg,
    sourceUpdatedAt: latest.updatedAt,
  });
});

/**
 * POST /calc/alt
 * Body: { heat_kWh: number, efficiency: number, gasFactor_kg_per_kWh?: number }
 * Default: efficiency=0.85 (85%), gasFactor=0.201 kg/kWh
 */
fastify.post("/calc/alt", async (req, rep) => {
  const body = await (req as any).body;
  const schema = z.object({
    heat_kWh: z.number().positive(),
    efficiency: z.number().gt(0).lte(1).default(0.85),
    gasFactor_kg_per_kWh: z.number().positive().default(0.201),
  });
  const { heat_kWh, efficiency, gasFactor_kg_per_kWh } = schema.parse(body);

  const requiredFuel_kWh = heat_kWh / efficiency;
  const co2Kg = requiredFuel_kWh * gasFactor_kg_per_kWh;

  return rep.send({
    input: { heat_kWh, efficiency, gasFactor_kg_per_kWh },
    requiredFuel_kWh,
    co2_kg: co2Kg,
  });
});

/**
 * POST /calc/savings
 * Body: { heat_kWh: number, cop: number, gasFactor_kg_per_kWh?: number }
 * Nutzt aktuellen Stromfaktor aus Electricity Maps, rechnet WP vs. Gas
 */
fastify.post("/calc/savings", async (req, rep) => {
  const body = await (req as any).body;
  const schema = z.object({
    heat_kWh: z.number().positive(),
    cop: z.number().gt(0),
    gasFactor_kg_per_kWh: z.number().positive().default(0.201),
  });
  const { heat_kWh, cop, gasFactor_kg_per_kWh } = schema.parse(body);

  const elec_kWh = heat_kWh / cop;
  const latest = await emFetch<{ carbonIntensity: number; updatedAt: string }>(
    "/v3/carbon-intensity/latest"
  );
  const elecFactorKg = latest.carbonIntensity / 1000;

  const co2_wp = elec_kWh * elecFactorKg;
  const co2_gas = (heat_kWh / 0.85) * gasFactor_kg_per_kWh;
  const savings = co2_gas - co2_wp;

  return rep.send({
    input: { heat_kWh, cop, elec_kWh },
    factors: {
      electricity_kgCO2_per_kWh: elecFactorKg,
      gas_kgCO2_per_kWh: gasFactor_kg_per_kWh,
      gas_efficiency: 0.85,
    },
    co2_wp_kg: co2_wp,
    co2_gas_kg: co2_gas,
    savings_kg: savings,
    sourceUpdatedAt: latest.updatedAt,
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" });
