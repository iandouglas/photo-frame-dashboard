// Open-Meteo forecast (free, no key): current conditions, 10-day daily, sunrise/sunset.

// WMO weather interpretation codes -> short label and icon name used by the frame.
const WMO = {
  0: ['Clear', 'sun'],
  1: ['Mostly clear', 'sun'],
  2: ['Partly cloudy', 'partly'],
  3: ['Overcast', 'cloud'],
  45: ['Fog', 'fog'],
  48: ['Freezing fog', 'fog'],
  51: ['Light drizzle', 'rain'],
  53: ['Drizzle', 'rain'],
  55: ['Heavy drizzle', 'rain'],
  56: ['Freezing drizzle', 'sleet'],
  57: ['Freezing drizzle', 'sleet'],
  61: ['Light rain', 'rain'],
  63: ['Rain', 'rain'],
  65: ['Heavy rain', 'rain'],
  66: ['Freezing rain', 'sleet'],
  67: ['Freezing rain', 'sleet'],
  71: ['Light snow', 'snow'],
  73: ['Snow', 'snow'],
  75: ['Heavy snow', 'snow'],
  77: ['Snow grains', 'snow'],
  80: ['Showers', 'rain'],
  81: ['Showers', 'rain'],
  82: ['Heavy showers', 'rain'],
  85: ['Snow showers', 'snow'],
  86: ['Snow showers', 'snow'],
  95: ['Thunderstorm', 'storm'],
  96: ['Thunderstorm, hail', 'storm'],
  99: ['Thunderstorm, hail', 'storm'],
};

export function describe(code, isDay) {
  const d = WMO[code] || ['—', 'cloud'];
  let icon = d[1];
  if (isDay === 0 && (icon === 'sun' || icon === 'partly')) icon = icon === 'sun' ? 'moon' : 'partly-night';
  return { label: d[0], icon };
}

export function forecastUrl(cfg) {
  const p = new URLSearchParams({
    latitude: String(cfg.lat),
    longitude: String(cfg.lon),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset',
    timezone: cfg.tz,
    forecast_days: '10',
  });
  if (cfg.units === 'imperial') {
    p.set('temperature_unit', 'fahrenheit');
    p.set('wind_speed_unit', 'mph');
    p.set('precipitation_unit', 'inch');
  }
  return 'https://api.open-meteo.com/v1/forecast?' + p.toString();
}

/** Map Open-Meteo's response to what the frame renders. Times stay local wall-clock strings. */
export function mapForecast(raw, cfg) {
  const c = raw.current || {};
  const d = raw.daily || {};
  const days = (d.time || []).map((date, i) => ({
    date,
    hi: round(d.temperature_2m_max && d.temperature_2m_max[i]),
    lo: round(d.temperature_2m_min && d.temperature_2m_min[i]),
    pop: d.precipitation_probability_max ? d.precipitation_probability_max[i] : null,
    sunrise: hhmm(d.sunrise && d.sunrise[i]),
    sunset: hhmm(d.sunset && d.sunset[i]),
    ...describe(d.weather_code && d.weather_code[i], 1),
  }));
  return {
    location: cfg.locationName,
    units: cfg.units === 'imperial' ? { temp: '°F', wind: 'mph' } : { temp: '°C', wind: 'km/h' },
    current: {
      temp: round(c.temperature_2m),
      feels: round(c.apparent_temperature),
      humidity: c.relative_humidity_2m,
      wind: round(c.wind_speed_10m),
      ...describe(c.weather_code, c.is_day),
    },
    days,
  };
}

function round(v) {
  return typeof v === 'number' ? Math.round(v) : null;
}

/** "2026-10-14T07:12" -> "07:12" (already local to the configured zone). */
function hhmm(s) {
  return typeof s === 'string' && s.length >= 16 ? s.slice(11, 16) : null;
}
