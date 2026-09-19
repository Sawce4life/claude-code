# Lead Assistant

An assistant that keeps track of your leads the way a good human assistant
would: who to call today, what you said last time, what you promised, and when
you said you would call back.

It runs as one small web app you install on your phone and your computer. Every
device signs into the same account and stays in step automatically. It keeps
working when you have no signal, and catches up when you do.

---

## What it actually does

**Today** opens on a call list that is already in order. Missed callbacks sit at
the top, then anything you scheduled for today, then people you have never
called, then anyone going quiet. Each line says why that name is there: *"Call
back about pricing — was due 2 days ago"*.

**Logging a call takes one sentence.** Type or dictate what happened the way you
would say it out loud:

> Just got off with Mike at Acme, interested but wants to run it past his
> partner. Call back Thursday morning.

It works out who you meant, writes the summary, sets the callback for Thursday
at 9, and moves Mike up your pipeline. You see all of that before it saves, and
you can change any of it.

**Ask it anything** about your own book: *"Who have I not called in over a
week?"*, *"What did I last tell Sarah about pricing?"*, *"Did I promise anyone
anything I have not done?"*

It never invents a name, a number, or a promise you did not make. If your notes
do not answer the question, it says so.

---

## Getting it running

You need **Node.js 22.5 or newer**, which is a free download from
[nodejs.org](https://nodejs.org). Everything else installs itself.

### Try it on your own computer first

Open a terminal in this folder and run:

```bash
npm install
npm run build
npm start
```

Open <http://localhost:8080>, create an account, and have a look around. That
account and its data live in a file called `data/lead-assistant.db` right here
on your machine.

### Put it online so your devices sync

Syncing needs the app to live somewhere both your phone and your laptop can
reach. Any host that runs Docker will do. The cheapest sensible options are
[Render](https://render.com), [Railway](https://railway.app) and
[Fly.io](https://fly.io), all of which cost a few dollars a month.

**On Render**, which needs the least fiddling:

1. Push this folder to a GitHub repository.
2. In Render, choose **New → Blueprint** and point it at that repository. It
   reads `render.yaml` and sets itself up.
3. When it asks for `ANTHROPIC_API_KEY`, paste your key, or leave it empty for
   now. Everything except the AI features works without one.
4. Wait for the first deploy, then open the address it gives you.

Two things to do once it is live:

- Create your account.
- Go back to Render and set `SIGNUPS` to `closed`, then redeploy. That stops
  anyone else signing up on your server.

**Anywhere that runs Docker**, including your own machine:

```bash
docker build -t lead-assistant .
docker run -p 8080:8080 -v lead-data:/data \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  lead-assistant
```

The `-v lead-data:/data` part is what keeps your leads when the container
restarts. Do not skip it.

---

## Installing it on your devices

There is no App Store download. You install it straight from the browser, and
afterwards it behaves like any other app: its own icon, its own window, no
address bar, and it opens whether or not you have signal.

| Device | How |
| --- | --- |
| iPhone, iPad | Open the address in **Safari**, tap Share, then **Add to Home Screen** |
| Android | Open in **Chrome**, tap the three dots, then **Install app** |
| Windows | Open in **Chrome** or **Edge**, click the install icon in the address bar |
| Mac | **Chrome** or **Edge**: the install icon in the address bar. **Safari**: File, then Add to Dock |

Sign in once on each device. From then on they all show the same leads within a
few seconds of each other.

---

## Turning on the assistant

The app is fully usable without an API key. You get the call list, the history,
the callbacks, and a simpler on-device reader for your notes. What a key adds is
the daily plan, the sharper reading of what you typed, the per-lead suggestions,
and the ability to ask questions.

1. Get a key from [console.anthropic.com](https://console.anthropic.com/settings/keys).
2. Set it as `ANTHROPIC_API_KEY` wherever the app runs. On Render that is
   Environment in the dashboard; locally it goes in a file called `.env` next to
   this README. Copy `.env.example` to `.env` to see the shape of it.
3. Restart the app.

Settings inside the app tells you whether the assistant is on.

Usage is billed by Anthropic per request. Ordinary daily use is cents, not
dollars, but it is your account and your bill.

---

## How the syncing works, and what happens offline

Every device keeps its own full copy of your leads. Screens read from that copy,
which is why the app opens instantly and works in a lift or a basement.

When you change something, it saves on the device first and joins a queue. The
queue empties to the server as soon as there is a connection: within a second or
two normally, and the moment you come back into signal otherwise. Other devices
pick the change up on their next check, which happens when you open the app,
when you switch back to it, and every 45 seconds while it is in front of you.

If the same lead is edited on two devices, the more recent edit wins. Call
history is never overwritten, because each logged call is its own record.

The dot in the top right tells you where things stand. Tap it to sync now.

---

## Your data

It is yours and it is in one file. Settings has two export buttons: a CSV of
your leads for a spreadsheet, and a JSON file with everything including your
call history.

To back up the whole thing, copy `data/lead-assistant.db`. On a host with a
disk, download it from there. Do that occasionally.

Signing out wipes the copy on that device but leaves the server untouched.

---

## If something goes wrong

**The app says it cannot reach the server.** It keeps working from the device
copy, so carry on. Anything you change syncs when the connection returns.

**Everyone got signed out after a restart.** `SESSION_SECRET` changed. Set it to
a fixed value in your environment rather than letting it regenerate. Generate
one with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

**The leads are gone after a redeploy.** The database was not on a persistent
disk. On Render that is the `disk:` block in `render.yaml`; in Docker it is the
`-v lead-data:/data` flag.

**The AI features say the key is missing.** The server did not pick up
`ANTHROPIC_API_KEY`. Check it is set where the server runs, not only on your own
machine, and restart.

**An old version keeps loading on your phone.** Close the app fully and reopen
it. It updates itself on the next launch after that.

---

## For anyone reading the code

```
shared/      ranking, timezone maths, the note parser, record shapes
             (imported by both sides so they can never disagree)
server/src/  HTTP server, SQLite storage, sync engine, Claude calls
web/src/     the app: local storage, sync client, screens
scripts/     dev runner, icon generator
```

```bash
npm run dev     # API on 8080, web on 5173 with live reload
npm test        # 66 tests: ranking, sync, parsing, HTTP API
npm run build   # build the web app into web/dist
npm start       # serve the built app and the API together
npm run icons   # regenerate the app icons
```

Worth knowing:

- The server has exactly one runtime dependency, the Anthropic SDK. Storage is
  Node's built-in SQLite, so there is no native build step and no database to
  install.
- Sync is per-user sequence numbers with last-write-wins on the client's own
  edit time, plus tombstones for deletes. A truncated page moves the cursor only
  to the lowest safe watermark, so a change can never be skipped.
- The ranking engine is a pure function, shared byte for byte with the client,
  which is why the offline list matches the server's.
- The assistant runs on Claude Opus 5. Note parsing uses strict tool use so the
  fields come back valid, and answers are streamed.
- Everything the assistant is given comes from that one account's own records.

## Licence

MIT.
