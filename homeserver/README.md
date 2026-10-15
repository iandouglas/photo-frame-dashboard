# Frame home server

A small LAN server for the PF1007 frame: your Google calendars, local weather, a pomodoro timer,
and a flashing countdown before meetings. It runs on the home NAS in Docker; the frame's kiosk app
just opens `http://<nas>:8088/`.

The frame never holds a password or calendar link. It runs Android 6 with a setuid `su`, so
anything stored on it should be treated as public. The calendar links live only in the NAS's
container settings.

## What's on the screen

| Column | Shows |
| --- | --- |
| Agenda | The next 14 days from all calendars, colour-coded. A meeting that is on two of your calendars appears once ("Work + Home"). Declined and cancelled events are hidden |
| Now | Clock and date, current weather, sunrise and sunset, a 10-day forecast ([Open-Meteo](https://open-meteo.com/), no API key). Tap a day for its hourly forecast |
| Tools | **Next meeting** from the calendars marked `alert`, with a countdown from 15 minutes out. **Pomodoro** with start/pause, skip, reset and on-screen settings. An optional **text card** (see `TEXT_FEED_URL`) |

**Meeting alert:** 2 minutes before an event on an `alert` calendar, the whole screen flashes red
until someone taps **ACK**. The ACK is saved on the server, so a reload or a second screen doesn't
start flashing again. If nobody taps it, the flashing stops 10 minutes after the start. All three
times are settings.

**Hourly forecast:** tap a day in the 10-day list to see that day hour by hour (time, sky, chance
of rain, temperature) in the same panel; scroll it with a finger. **‹** goes back, and so does a
minute without touching the panel. A day the forecast has no hours for says *No hourly forecast yet*.

**Text card:** set `TEXT_FEED_URL` to any address that returns plain text, for example
`https://dadjokes736.com`, which returns a new dad joke on each request. The card under the pomodoro
shows it exactly as served and refreshes every 15 seconds. The NAS fetches the text (never the
frame), at most once every 10 seconds however many screens are open, accepts only `text/*`
responses and keeps the first 2 KB. The frame shows it as text, so HTML in the response is
displayed, not run. If the site is down, the last text stays up in grey. Leave the setting empty to hide the card;
`TEXT_FEED_TITLE` adds a heading.

**Pomodoro:** the timer runs on the server's clock, so it survives a kiosk reload, and you can
start it from a phone browser on the same URL. When a phase ends, the card pulses for 8 seconds
and the button offers the next phase (a long break after every 4th focus session by default).

## 1. Get each calendar's secret iCal address

Do this for each calendar, signed in to the account that owns it (work, personal Gmail, home
Workspace):

1. Open Google Calendar on a computer → **Settings** (gear) → under **Settings for my calendars**,
   click the calendar.
2. Scroll to **Integrate calendar** → **Secret address in iCal format** → copy. It looks like
   `https://calendar.google.com/calendar/ical/…/private-…/basic.ics`.

> **This link is a password.** Anyone with it can read every event on that calendar, with
> titles, attendees and meeting links, without signing in. Don't put it in a URL shortener, a
> chat, a repo or a screenshot, and don't type it into the frame. If it leaks, click **Reset** next
> to it in Google Calendar to make a new one.

If **Secret address in iCal format** is missing, the Workspace admin has turned it off (common on
work accounts). Then use `busyOnly` on a different feed, or ask your admin; this server cannot sign
in to Google on its own.

## 2. Deploy on the NAS with Portainer

1. **Stacks → Add stack**, name it `frame`, and choose **Repository**:
   - Repository URL: this repository's GitHub URL (it is public, so no authentication)
   - Repository reference: `refs/heads/main`
   - Compose path: `homeserver/docker-compose.yml`

   Portainer clones the repository with its own git and builds the image on the NAS from
   `homeserver/`. The **Web editor** mode does not work here: it has no files to build from, and
   many NAS Docker installs have no `git` to fetch them (`git: executable file not found`).
2. Under **Environment variables**, add at least `CALENDARS`. The value is one line of JSON:

   ```json
   [{"id":"work","name":"Work","url":"https://calendar.google.com/…/basic.ics","color":"#3B6FD8","alert":true,"email":"you@work.example"},
    {"id":"personal","name":"Personal","url":"https://calendar.google.com/…/basic.ics","color":"#00A36C"},
    {"id":"consulting","name":"Consulting","url":"https://calendar.google.com/…/basic.ics","color":"#C2410C","alert":true}]
   ```

   (Join it onto one line.) Every field is described in [`.env.example`](.env.example). Useful ones:

   | Field | Effect |
   | --- | --- |
   | `alert: true` | Events on this calendar get the countdown and the flash |
   | `email` | Your address on that calendar; events you declined are hidden |
   | `busyOnly: true` | Show "Busy" instead of titles and locations, e.g. for work |
   | `exclude: ["^OOO", "lunch"]` | Hide events whose titles match (case-insensitive) |

3. **Deploy the stack.** Check it from a laptop: `http://<nas-ip>:8088/` should show the
   dashboard, and `http://<nas-ip>:8088/healthz` should return `{"ok":true}`. If a calendar
   fails, the agenda says which one and why (for example `HTTP_404`); the link itself is never
   logged or shown.

To change a setting later, edit the stack's environment variables and click **Update the stack**.
To pick up new code, open the stack and use **Pull and redeploy** (in the stack's Git section;
the reference must be `refs/heads/main`). The compose file sets `pull_policy: build`, so every
deploy rebuilds the image from the pulled files. Check `http://<nas-ip>:8088/healthz` afterwards.
Pomodoro settings and ACKs are kept in the `frame-data` volume.

Other settings, all optional: `HOST_PORT` (8088), `TZ`, `LAT`/`LON`/`LOCATION_NAME` (no default; weather stays off until set),
`UNITS` (`imperial` or `metric`), `REFRESH_MINUTES` (5), `EVENTS_DAYS` (14), `ALERT_LEAD_MIN` (2),
`ALERT_COUNTDOWN_MIN` (15), `ALERT_GRACE_MIN` (10), `WRITE_TOKEN` (see below), `TEXT_FEED_URL`
and `TEXT_FEED_TITLE` (no default; the text card stays hidden until set).

## 3. Point the frame at it

The frame shows the page in the repository's kiosk app ([`dashboard/kiosk`](../dashboard/kiosk)).
With the kiosk installed and ADB connected, save the URL once. Nothing is typed on the frame:

```sh
adb shell am start -n com.wesbos.homehq/.MainActivity --es url http://<nas-ip>:8088/
```

The kiosk allows plain HTTP, so the frame's missing HTTPS root certificates don't matter here. To
make the kiosk the frame's Home screen, see the [kiosk guide](../dashboard/kiosk/README.md#start-at-boot).

Give the NAS a fixed address (a DHCP reservation) so the saved URL keeps working.

## Optional: a write token

Anyone on your LAN can open the page and press its buttons. To limit button presses (ACK,
pomodoro) to screens you set up, set `WRITE_TOKEN` to a random string and save the kiosk URL as
`http://<nas-ip>:8088/?token=<value>`. Reading stays open on the LAN. This is a guard against
a curious guest, not real security: the token sits on the frame.

## Develop and test

```sh
cd homeserver
npm install
npm test        # calendars, time zones, weather, text feed, alert and pomodoro logic, old-WebView checks
```

Run it against the synthetic test calendars (file URLs are only accepted with `ALLOW_FILE_FEEDS=1`):

```sh
echo '[{"id":"work","url":"file://'"$PWD"'/test/fixtures/work.ics","alert":true}]' > ../tmp/cal.json
CALENDARS_FILE=../tmp/cal.json ALLOW_FILE_FEEDS=1 STATE_FILE=../tmp/state.json npm start
```

The page is plain ES5 and old-style CSS because the frame's stock WebView is Chrome 44: no build
step, no framework, no CSS variables or grid. `test/frontend.test.js` fails if newer syntax creeps in.
Times on the page come from the server, not the frame, whose clock and time zone are unreliable.

API, for scripts and phones: `GET /api/events`, `GET /api/weather` (with `days[].hours`),
`GET /api/text` (404 `NOT_CONFIGURED` when unset), `GET /api/state`,
`POST /api/ack {"key"}`, `POST /api/pomodoro {"settings"?, "run"?}`.
