# Ride Guide: audio bike tours

A small web app (PWA) for Android Chrome. It gives spoken turn-by-turn directions, tells stories about places as you pass them, and plays generated music underneath: slow ambient pads, or rolling tribal techno (pick under *Settings → Music style*). The music dips whenever the voice speaks.

## Put it online (one time, about 5 minutes)

Location access only works on an HTTPS site, so the app needs a free host. GitHub Pages is the easiest:

1. Sign in at github.com and click **New repository**. Name it `ride-guide`, make it **Public**, and create it.
2. On the new repo page, click **uploading an existing file**. Select **all the files** from the zip (there are no folders) and drag them in, then click **Commit changes**.
3. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, then **main** and **/ (root)**, and click **Save**.
4. After about a minute the app is live at `https://<your-username>.github.io/ride-guide/`.

> The repo and site are public, so the start address in the route file can be seen by anyone who finds them. If you'd rather not show it, change `start` and the first and last `waypoints` to a nearby street corner.

## On the phone

1. Open the link in **Chrome**. Tap **⋮ → Add to Home screen**.
2. On Wi-Fi, open the route once. It's calculated and saved on the phone, and the app shell works offline after that.
3. Tap **Test voice**. For a nicer voice, pick an *English (UK)* Google voice in the settings. You can install more voices in Android under *Settings → Text-to-speech*.
4. Try **Preview at home**, which simulates the ride along the route.
5. For the real ride, tap **Start ride**, allow location, then tap **Pocket mode**. The screen stays on but completely black, and you hold the button for 2 seconds to unlock it. **Don't press the power button**, because Android pauses GPS for web pages when the screen is off.

Tips: charge the phone first (the screen stays on). Use one earbud, or keep the volume low, so you can hear traffic. The chime falls for left turns and rises for right turns, and the phone buzzes twice for left and once for right.

## How it works

| Piece | File |
|---|---|
| UI, GPS, speech, pocket mode | `app.js` |
| Route geometry, turn cues, progress tracking | `nav.js` |
| Generated music, ambient and tribal techno (Web Audio, no audio files) | `music.js` |
| Offline caching | `sw.js` |
| Map library | `leaflet.js`, `leaflet.css` (+ its png images) |
| Route list | `index.json` |
| One route | `<route-id>.json` |

Everything lives in one flat folder, because GitHub's web upload drops folders when you drag in individual files.

When a route is first opened, the app asks the free community bike router (OSRM at routing.openstreetmap.de) for the path and turn steps, then caches the result on the phone. It merges tiny sidewalk jogs into clean instructions ("In 200 metres, turn left onto Knaackstraße") and tracks how far along the route you are. That way a place you pass twice (such as the Victory Column) is announced on the correct pass. Stories wait until a turn instruction is done, and a turn instruction interrupts a story, which then picks up again at the sentence it was on.

## Adding a new route

Ask Claude: *"Add a Ride Guide route from A via B to C"*. Or do it by hand:

1. Copy `berlin-prenzlauer-berg-loop.json` to `my-new-route.json` and change:
   - `id`, `name`, `city`, `description`, `intro`, `outro`
   - `waypoints`: `[lat, lon]` points in riding order. The first is the start, and the last equals the first for a loop. Put shaping points **on** the street you want to use, not beside it, or the router may make a little detour loop to reach them.
   - `pois`: `{ id, name, lat, lon, text }` in riding order. `text` is what gets spoken; keep it to about 60–90 words. You can add `"trigger": [lat, lon]` to fire a story at a specific point on the route.
   - `cueOverrides` (optional): `{ lat, lon, radius, text, dir }` replaces an awkward generated instruction near that point, and `{ lat, lon, radius, drop: true }` removes one.
2. Add an entry to `index.json`.
3. Upload the changed files to the GitHub repo. The phone picks up the changes the next time you open the app online.
