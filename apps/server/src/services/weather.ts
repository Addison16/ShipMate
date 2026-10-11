/**
 * Weather from Open-Meteo (https://open-meteo.com): free, keyless, no account. Places are
 * geocoded with Open-Meteo's geocoding API. Results are cached briefly so a morning of
 * briefings does not ask twice.
 */

type Fetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface Place {
  name: string;
  region: string | null;
  country: string | null;
  countryCode: string | null;
  latitude: number;
  longitude: number;
  timezone: string | null;
}

export interface Forecast {
  place: Place;
  units: "celsius" | "fahrenheit";
  current: { temperature: number; weatherCode: number; windSpeed: number } | null;
  days: Array<{
    date: string;
    weatherCode: number;
    max: number;
    min: number;
    precipitationChance: number | null;
    precipitation: number | null;
    windMax: number | null;
  }>;
}

const CACHE_MS = 15 * 60_000;
/** Countries that use Fahrenheit day to day. */
const FAHRENHEIT = new Set(["US", "LR", "MM", "BS", "BZ", "KY", "PW", "FM", "MH"]);

/** "TX" in "Austin, TX" means Texas; geocoding results name the state in full. */
const US_STATES: Record<string, string> = {
  AL: "Alabama",
  AK: "Alaska",
  AZ: "Arizona",
  AR: "Arkansas",
  CA: "California",
  CO: "Colorado",
  CT: "Connecticut",
  DE: "Delaware",
  DC: "District of Columbia",
  FL: "Florida",
  GA: "Georgia",
  HI: "Hawaii",
  ID: "Idaho",
  IL: "Illinois",
  IN: "Indiana",
  IA: "Iowa",
  KS: "Kansas",
  KY: "Kentucky",
  LA: "Louisiana",
  ME: "Maine",
  MD: "Maryland",
  MA: "Massachusetts",
  MI: "Michigan",
  MN: "Minnesota",
  MS: "Mississippi",
  MO: "Missouri",
  MT: "Montana",
  NE: "Nebraska",
  NV: "Nevada",
  NH: "New Hampshire",
  NJ: "New Jersey",
  NM: "New Mexico",
  NY: "New York",
  NC: "North Carolina",
  ND: "North Dakota",
  OH: "Ohio",
  OK: "Oklahoma",
  OR: "Oregon",
  PA: "Pennsylvania",
  RI: "Rhode Island",
  SC: "South Carolina",
  SD: "South Dakota",
  TN: "Tennessee",
  TX: "Texas",
  UT: "Utah",
  VT: "Vermont",
  VA: "Virginia",
  WA: "Washington",
  WV: "West Virginia",
  WI: "Wisconsin",
  WY: "Wyoming",
};

export class WeatherError extends Error {}

export class WeatherService {
  #cache = new Map<string, { at: number; value: Forecast }>();

  constructor(
    private readonly fetchImpl: Fetch = fetch as unknown as Fetch,
    private readonly endpoints = {
      geocode: "https://geocoding-api.open-meteo.com/v1/search",
      forecast: "https://api.open-meteo.com/v1/forecast",
    },
  ) {}

  /** Look up "Austin, Texas" or "Berlin": the best match, preferring the region after a comma. */
  async geocode(query: string): Promise<Place> {
    const [name = "", ...rest] = query
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!name) throw new WeatherError("give a place, e.g. a town and country");
    const url = `${this.endpoints.geocode}?name=${encodeURIComponent(name)}&count=10&language=en&format=json`;
    const data = (await this.#get(url)) as { results?: Array<Record<string, unknown>> };
    const results = (data.results ?? []).map(toPlace).filter((p): p is Place => p !== null);
    if (!results.length) throw new WeatherError(`no place called "${query}" was found`);
    const hints = rest.flatMap((h) => {
      const lower = h.toLowerCase();
      const state = US_STATES[h.toUpperCase()];
      return state ? [lower, state.toLowerCase()] : [lower];
    });
    const matchesHint = (p: Place) =>
      hints.some((h) =>
        [p.region, p.country, p.countryCode].some(
          (v) => v && (v.toLowerCase() === h || v.toLowerCase().startsWith(h)),
        ),
      );
    return (hints.length ? results.find(matchesHint) : undefined) ?? (results[0] as Place);
  }

  async forecast(query: string, days = 3): Promise<Forecast> {
    const n = Math.min(7, Math.max(1, Math.round(days)));
    const key = `${query.trim().toLowerCase()}|${n}`;
    const hit = this.#cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const place = await this.geocode(query);
    const units = place.countryCode && FAHRENHEIT.has(place.countryCode) ? "fahrenheit" : "celsius";
    const params = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: "temperature_2m,weather_code,wind_speed_10m",
      daily:
        "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max",
      timezone: place.timezone ?? "auto",
      forecast_days: String(n),
      temperature_unit: units,
      wind_speed_unit: units === "fahrenheit" ? "mph" : "kmh",
      precipitation_unit: units === "fahrenheit" ? "inch" : "mm",
    });
    const data = (await this.#get(`${this.endpoints.forecast}?${params}`)) as {
      current?: Record<string, number>;
      daily?: Record<string, Array<number | string | null>>;
    };
    const d = data.daily ?? {};
    const dates = (d.time ?? []) as string[];
    const num = (arr: unknown, i: number) => {
      const v = Array.isArray(arr) ? arr[i] : null;
      return typeof v === "number" ? v : null;
    };
    const value: Forecast = {
      place,
      units,
      current:
        data.current && typeof data.current.temperature_2m === "number"
          ? {
              temperature: data.current.temperature_2m,
              weatherCode: data.current.weather_code ?? -1,
              windSpeed: data.current.wind_speed_10m ?? 0,
            }
          : null,
      days: dates.map((date, i) => ({
        date,
        weatherCode: num(d.weather_code, i) ?? -1,
        max: num(d.temperature_2m_max, i) ?? Number.NaN,
        min: num(d.temperature_2m_min, i) ?? Number.NaN,
        precipitationChance: num(d.precipitation_probability_max, i),
        precipitation: num(d.precipitation_sum, i),
        windMax: num(d.wind_speed_10m_max, i),
      })),
    };
    this.#cache.set(key, { at: Date.now(), value });
    return value;
  }

  async #get(url: string): Promise<unknown> {
    let res: Awaited<ReturnType<Fetch>>;
    try {
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    } catch (err) {
      throw new WeatherError(`the weather service did not answer (${(err as Error).message})`);
    }
    if (!res.ok) throw new WeatherError(`the weather service answered ${res.status}`);
    return res.json();
  }
}

function toPlace(r: Record<string, unknown>): Place | null {
  if (typeof r.latitude !== "number" || typeof r.longitude !== "number") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    name: str(r.name) ?? "?",
    region: str(r.admin1),
    country: str(r.country),
    countryCode: str(r.country_code),
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: str(r.timezone),
  };
}

/** WMO weather interpretation codes, as Open-Meteo reports them. */
export function describeWeatherCode(code: number): string {
  if (code === 0) return "clear";
  if (code === 1) return "mostly clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return code >= 66 ? "freezing rain" : "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "rain showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code >= 95) return "thunderstorms";
  return "unknown";
}

/** A forecast as a few plain lines for a crew member. */
export function formatForecast(f: Forecast): string {
  const deg = f.units === "fahrenheit" ? "°F" : "°C";
  const wind = f.units === "fahrenheit" ? "mph" : "km/h";
  const rain = f.units === "fahrenheit" ? "in" : "mm";
  const where = [f.place.name, f.place.region, f.place.country].filter(Boolean).join(", ");
  const lines = [`Weather for ${where} (Open-Meteo):`];
  if (f.current) {
    lines.push(
      `- Now: ${Math.round(f.current.temperature)}${deg}, ${describeWeatherCode(f.current.weatherCode)}, wind ${Math.round(f.current.windSpeed)} ${wind}`,
    );
  }
  for (const d of f.days) {
    const wet =
      d.precipitationChance !== null
        ? `, ${d.precipitationChance}% chance of rain${d.precipitation ? ` (${d.precipitation} ${rain})` : ""}`
        : "";
    const windy = d.windMax !== null ? `, wind up to ${Math.round(d.windMax)} ${wind}` : "";
    lines.push(
      `- ${d.date}: ${describeWeatherCode(d.weatherCode)}, ${Math.round(d.min)} to ${Math.round(d.max)}${deg}${wet}${windy}`,
    );
  }
  return lines.join("\n");
}
