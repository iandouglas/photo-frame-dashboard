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
| Agenda | Today from all calendars, colour-coded: all-day events, then what hasn't ended yet (finished events drop off as they end), then below a divider the first event of the next day that has any ("Tomorrow" or "Mon Oct 19"). A meeting that is on two of your calendars appears once ("Work + Home"). Declined and cancelled events are hidden. **‹ ›** beside the day step a day back or forward (30 days back, 90 ahead) and show that whole day; tap the day to return to today, which also happens after 2 minutes untouched |
| News | Optional (`NEWS_FEEDS`): an **Agenda \| News** switch at the top of the left column. Headlines from your RSS/Atom feeds, newest first, with the source and "12m ago". Text only: nothing opens on the frame. The frame remembers which tab you left it on |
| Now | Clock with seconds (screen-off and Settings buttons in its corner), date, current weather, sunrise and sunset, a 10-day forecast ([Open-Meteo](https://open-meteo.com/), no API key). Tap a day for its hourly forecast |
| Tools | **Next meeting** from the calendars marked `alert` (day, time and calendar on one line, the title below), with a countdown from 15 minutes out. **Pomodoro** with start/pause, skip, reset and on-screen settings. An optional **text card** (see `TEXT_FEED_URL`) |

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

## 1. Getting your Google Calendar iCal addresses

The server reads each calendar through its **secret iCal address**: a private link that Google
keeps up to date. Get one per calendar you want on the frame (for example work, personal Gmail and
a home Workspace calendar). Do it on a computer; the phone app doesn't show these settings.

1. Open [calendar.google.com](https://calendar.google.com) in a browser, signed in to the account
   that **owns** the calendar.
2. In the left sidebar, under **My calendars**, hover over the calendar.
3. Click the **⋮** (three dots) that appears → **Settings and sharing**.
4. Scroll down to **Integrate calendar**.
5. Copy **Secret address in iCal format**. It looks like
   `https://calendar.google.com/calendar/ical/…/private-…/basic.ics`.
   Do **not** use "Public address in iCal format": that one only works for calendars made public
   to the whole internet.
6. Repeat for each calendar and account.

> **Treat each secret address as a password.** Anyone with it can read every event on that
> calendar, with titles, attendees and meeting links, without signing in. Don't put it in a URL
> shortener, a chat, a repo, a screenshot or the frame itself. The **Reset** button next to it,
> in the same place, revokes the old link and makes a new one; then update `CALENDARS`.

### If "Secret address in iCal format" is missing (Workspace accounts)

On work and other Google Workspace accounts the field can be missing, because the admin has
turned off sharing calendars outside the organisation. An admin can allow it in the
**Admin console → Apps → Google Workspace → Calendar → Sharing settings → External sharing
options** ("Allow users to share their calendars"); many companies won't.

What still works without it:

- **Share the work calendar with your personal account.** In the work calendar's
  **Settings and sharing → Share with specific people**, add your personal Gmail address with
  "See only free/busy" or "See all event details" (whatever your company allows). This server
  can't read a calendar that is only *shared with* or *subscribed to* by another account: Google
  shows no secret address for those. So this helps only if your company lets the work account
  produce its own secret address, or if you mirror the events some other way.
- If you do get a work feed in, add `"busyOnly": true` to show "Busy" instead of titles.
- Otherwise, push it from the laptop that already shows it in the macOS Calendar app: see
  [Work calendar from a Mac](#work-calendar-from-a-mac-push).

### Put them into Portainer

`CALENDARS` is **one line** of JSON, a list with one entry per calendar. Write it in a text editor
first:

```json
[
  {"id":"work","name":"Work","url":"PASTE-WORK-SECRET-ADDRESS","color":"#3B6FD8","alert":true,"busyOnly":true},
  {"id":"personal","name":"Personal","url":"PASTE-PERSONAL-SECRET-ADDRESS","color":"#00A36C"},
  {"id":"home","name":"Home","url":"PASTE-HOME-SECRET-ADDRESS","color":"#C2410C","alert":true}
]
```

then remove the line breaks so it is a single line (`[{"id":"work",…},{"id":"personal",…}]`),
and paste that as the value of `CALENDARS` in the stack's **Environment variables**. Click
**Update the stack**. The server reads the calendars at start-up and again every
`REFRESH_MINUTES` (5 by default), so later changes inside Google show up within that time; changes
to `CALENDARS` itself take effect when you update the stack. If one calendar fails, the agenda
names it and the reason (for example `HTTP_404` after a **Reset**); the address itself is never
logged or shown.

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
and `TEXT_FEED_TITLE` (no default; the text card stays hidden until set), `NEWS_FEEDS` and
`NEWS_MINUTES` (see below), `PUSH_CALENDARS` and `PUSH_STALE_MINUTES` (see
[Work calendar from a Mac](#work-calendar-from-a-mac-push)), `SCREEN_OFF_FROM`, `SCREEN_OFF_TO` and `WAKE_MINUTES` (see
[Screen off](#screen-off-night-schedule-and-settings)).

### News feeds

`NEWS_FEEDS` is one line of JSON, `[{"name":"NPR","url":"https://feeds.npr.org/1001/rss.xml"}]`
(up to 12 feeds). Unset or empty hides the News tab. The server fetches every feed every
`NEWS_MINUTES` (10, minimum 5), reads RSS 2.0, RSS 1.0 and Atom, turns titles into plain text,
drops repeated headlines and keeps the newest 60. The frame shows the headline, the feed's `name`
and how long ago it was published; links are not sent to the frame.

Feeds that worked when this was written (October 2026):

| Name | URL |
| --- | --- |
| NPR News | `https://feeds.npr.org/1001/rss.xml` |
| BBC World | `https://feeds.bbci.co.uk/news/world/rss.xml` |
| Hacker News | `https://hnrss.org/frontpage` |
| Ars Technica | `https://feeds.arstechnica.com/arstechnica/index` |
| The Verge | `https://www.theverge.com/rss/index.xml` |

AP has no public RSS feed any more (`apnews.com/index.rss` answers 401), and the third-party AP
mirrors tried were weeks out of date; NPR and BBC are the dependable general-news choices. If a
feed fails, the News tab names it and the reason under the list.

## 3. Point the frame at it

The frame shows the page in the repository's kiosk app ([`dashboard/kiosk`](../dashboard/kiosk)).
With the kiosk installed and ADB connected, save the URL once. Nothing is typed on the frame:

```sh
adb shell am start -n com.wesbos.homehq/.MainActivity --es url http://<nas-ip>:8088/
```

The kiosk allows plain HTTP, so the frame's missing HTTPS root certificates don't matter here. To
make the kiosk the frame's Home screen, see the [kiosk guide](../dashboard/kiosk/README.md#start-at-boot).

Give the NAS a fixed address (a DHCP reservation) so the saved URL keeps working.

## Work calendar from a Mac (push)

For a calendar the server can't read itself (typically a Google Workspace calendar whose admin
disabled secret addresses), a Mac that already shows it can push it. `push-macos/frame-push`
reads the chosen calendars through the macOS Calendar app every 5 minutes and sends **only the
title, start, end and all-day flag** of each event (or "Busy", with `busyOnly`). Attendees,
descriptions, locations, links and conference details are never read into the payload, and the
server drops any other field it is sent. Declined and cancelled events are skipped.

**1. Server.** Make up a long random token (`push-macos/install.sh --print-token` prints one) and
add the calendar to the stack's environment, then **Update the stack**:

```
PUSH_CALENDARS=[{"id":"work","name":"Work","color":"#3B6FD8","alert":true,"token":"PASTE-THE-TOKEN"}]
```

`id` shares one namespace with `CALENDARS` (pick an id that isn't used there). The token is a
password for this one calendar: it can replace that calendar's events and nothing else.
`PUSH_STALE_MINUTES` (60) marks the calendar as `STALE` in the agenda's status line when no push
has arrived for that long; the last snapshot stays on screen.

**2. Mac: add the work account to Calendar.** System Settings → **Internet Accounts** → **Add
Account** → **Google**, sign in with the work account, and leave **Calendars** switched on. Open
the Calendar app and check that the work calendar shows up.

**3. Mac: install the pusher** (needs the Xcode command line tools for `swiftc`:
`xcode-select --install`). From a clone of this repository:

```sh
cd homeserver/push-macos
./install.sh --list-calendars   # builds it, asks for Calendar access (click Allow), lists calendars
./install.sh                    # first run: creates the config file and stops
```

Edit `~/Library/Application Support/frame-push/config.json`:

| Field | Meaning |
| --- | --- |
| `server` | `http://<nas-ip>:8088` |
| `pushId` | the `id` from `PUSH_CALENDARS` |
| `calendars` | identifiers (third column of `--list-calendars`) or calendar titles |
| `daysAhead` / `daysBack` | window to send (14 / 1; up to 60 ahead) |
| `busyOnly` | `true` sends "Busy" instead of titles |
| `exclude` | regular expressions; matching titles are not sent (case-insensitive) |
| `skipDeclined` | `true` (default) leaves out meetings you declined |

Then run `./install.sh` again. It asks you to paste the token (stored in your login Keychain,
service `frame-push`), shows nothing on screen, does a dry run, and loads a LaunchAgent
(`~/Library/LaunchAgents/io.github.photo-frame-dashboard.frame-push.plist`) that pushes now and
every 5 minutes. When the Mac is away from home the push fails quietly and is retried.

- See what is sent: `~/Library/Application\ Support/frame-push/frame-push --dry-run`
- Log: `~/Library/Logs/frame-push.log`
- After changing the config nothing else is needed; after updating this repository, run
  `./install.sh` again (a rebuilt tool asks for the token once more).
- Remove: `./uninstall.sh` (keeps config and token) or `./uninstall.sh --purge`.

The pushed calendar behaves like the others: its colour, alerts (with `"alert": true`), date
navigation, and the status line, which shows when it was last updated.

## Screen off, night schedule and Settings

The top-right corner of the clock has two small buttons:

- **Moon:** turns the screen off. In the Home HQ kiosk this switches the frame's backlight off
  (see the [kiosk guide](../dashboard/kiosk/README.md#screen-off-and-settings-from-the-page-windowhomehq);
  it uses the frame's root `su`). In an ordinary browser the page just goes black. The next
  touch turns it back on and does nothing else.
- **Gear:** opens Android Settings. Shown only in the kiosk.

Night schedule (stack environment, local time in `TZ`, both unset = no schedule):

| Setting | Example | Effect |
| --- | --- | --- |
| `SCREEN_OFF_FROM` | `22:30` | Screen off from this time... |
| `SCREEN_OFF_TO` | `06:30` | ...until this time. The window may cross midnight |
| `WAKE_MINUTES` | `2` (default) | A touch during the window keeps the screen on this long, then it goes off again |

A meeting alert turns the screen on and flashes even during the window. Tapping **ACK** counts as
a touch: the screen stays on for `WAKE_MINUTES`, then the schedule resumes.

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

Calendars are expanded once per refresh (and at local midnight) over the whole window the agenda
can reach, in small slices so the server keeps answering meanwhile; requests just filter that.
The log line `calendar_expanded` gives the time and occurrence count per calendar (no titles).
`test/helpers/bigfeed.js` generates a feed with years of history for testing this.

`GET /api/state` also returns the screen schedule as `screen: {from, to, wakeMin}`.
`PUT /api/push/<id>` with `Authorization: Bearer <token>` and `{"events":[{uid, title, start, end}
| {uid, title, allDay: true, startDate, endDate}]}` replaces a pushed calendar (at most 500 events,
256 KB; titles are cut at 200 characters).

API, for scripts and phones: `GET /api/events` (optionally `?from=YYYY-MM-DD&days=1..14`, within
30 days back and 90 ahead; `building: true` while calendars are still being expanded after a
refresh, with whatever is ready; without `from`, `following` is the first event after the
default window), `GET /api/news` (404 `NOT_CONFIGURED` when unset), `GET /api/weather` (with `days[].hours`),
`GET /api/text` (404 `NOT_CONFIGURED` when unset), `GET /api/state`,
`POST /api/ack {"key"}`, `POST /api/pomodoro {"settings"?, "run"?}`.
