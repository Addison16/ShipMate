import { describe, expect, it } from "vitest";
import { describeWeatherCode, formatForecast, WeatherService } from "./weather.js";

/** A stand-in for Open-Meteo: two Austins and a three-day forecast. */
function fakeFetch(calls: string[]) {
  return async (url: string) => {
    calls.push(url);
    const body = url.includes("geocoding")
      ? {
          results: [
            {
              name: "Austin",
              admin1: "Minnesota",
              country: "United States",
              country_code: "US",
              latitude: 43.67,
              longitude: -92.97,
              timezone: "America/Chicago",
            },
            {
              name: "Austin",
              admin1: "Texas",
              country: "United States",
              country_code: "US",
              latitude: 30.27,
              longitude: -97.74,
              timezone: "America/Chicago",
            },
          ],
        }
      : {
          current: { temperature_2m: 71.6, weather_code: 2, wind_speed_10m: 8.2 },
          daily: {
            time: ["2026-10-11", "2026-10-12"],
            weather_code: [61, 0],
            temperature_2m_max: [80.1, 84],
            temperature_2m_min: [60.4, 62],
            precipitation_probability_max: [70, 5],
            precipitation_sum: [0.4, 0],
            wind_speed_10m_max: [12, 6],
          },
        };
    return { ok: true, status: 200, json: async () => body };
  };
}

describe("WeatherService", () => {
  it("geocodes with the region hint and uses local units", async () => {
    const calls: string[] = [];
    const weather = new WeatherService(fakeFetch(calls));
    const f = await weather.forecast("Austin, TX", 2);
    expect(f.place.region).toBe("Texas");
    expect(f.units).toBe("fahrenheit");
    expect(calls[1]).toContain("latitude=30.27");
    expect(calls[1]).toContain("temperature_unit=fahrenheit");
    expect(calls[1]).toContain("forecast_days=2");
    const text = formatForecast(f);
    expect(text).toContain("Weather for Austin, Texas, United States");
    expect(text).toContain("Now: 72°F, partly cloudy");
    expect(text).toContain("2026-10-11: rain, 60 to 80°F, 70% chance of rain (0.4 in)");
    // Cached: a second ask does not call out again.
    await weather.forecast("austin, tx", 2);
    expect(calls).toHaveLength(2);
  });

  it("explains failures in plain words", async () => {
    const weather = new WeatherService(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    await expect(weather.forecast("Atlantis")).rejects.toThrow(/no place called "Atlantis"/);
    const down = new WeatherService(async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(down.forecast("Berlin")).rejects.toThrow(/did not answer/);
  });

  it("names weather codes", () => {
    expect(describeWeatherCode(0)).toBe("clear");
    expect(describeWeatherCode(95)).toBe("thunderstorms");
    expect(describeWeatherCode(73)).toBe("snow");
  });
});
