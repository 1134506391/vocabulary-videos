# Vocabulary video generation pipeline

This NestJS service imports the 26 vocabulary chapters into SQLite, creates one
five-second Agnes video per sentence, resumes unfinished work after restarts,
downloads MP4 files in source order, and can concatenate a completed chapter
with FFmpeg.

## Prerequisites

- Node.js and npm
- FFmpeg on `PATH` (only needed for chapter assembly)
- A newly issued Agnes API key

The key that used to be present in `src/static/generator-video.vue` must be
revoked. Never put an Agnes key in Vue or other browser code.

## Setup

```bash
npm install
copy .env.example .env
```

Set Agnes keys once (either seed from `.env` or add via API). After the first
seed, keys live in SQLite table `agnes_api_keys` and rotate automatically.

```env
AGNES_API_KEY_1=sk-...
AGNES_API_KEY_2=sk-...
AGNES_API_KEY_3=sk-...
```

Or add without restarting:

```powershell
Invoke-RestMethod -Method Post -ContentType "application/json" `
  -Body '{"apiKey":"sk-...","label":"account-2"}' `
  http://localhost:3000/videos/keys
```

Quota logic:

- `DAILY_VIDEO_SECONDS` is a **soft estimate** for logs/stats only.
- Real stop condition is Agnes **HTTP 429 quota** on a key.
- When one key hits quota, it is marked exhausted for the local day and the
  worker switches to the next key automatically.
- New submissions pause only when **all enabled keys** are exhausted today.

Other defaults:

- `VIDEO_TIMEZONE=Asia/Shanghai` controls the daily reset date.
- `VIDEO_POLL_INTERVAL_MS` controls how often the worker polls Agnes for
  status. Agnes rejects too-frequent status requests, so the worker enforces
  a minimum of `60s`.
- `WORKER_AUTO_START=true` resumes processing when the server restarts.
- `DATABASE_PATH=./data/vocabulary-videos.sqlite` keeps queue progress.
- `VIDEO_OUTPUT_ROOT=./videos` stores clips, manifests, and chapter videos.
- `LOG_DIRECTORY=./logs` stores daily rotated logs; `LOG_RETENTION=14d` keeps
  two weeks by default.

Start the service:

```bash
npm run start:dev
```

## Import the TXT files

The current files do not explicitly mark whether each non-empty line is a word
or a sentence. The importer infers boundaries from ordering, length, and
punctuation. Always inspect the preview, especially its `ambiguities`, before
confirming.

```powershell
Invoke-RestMethod http://localhost:3000/import/preview

Invoke-RestMethod `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"forceAmbiguous":true}' `
  http://localhost:3000/import/confirm
```

Importing is idempotent: running it again updates matching source positions
instead of duplicating chapters, words, sentences, or jobs. If sentence text
changes, its job returns to `pending`.

## Operate the queue

```powershell
# Progress by state and chapter, plus recent daily usage and key status
Invoke-RestMethod http://localhost:3000/videos/status

# List API keys (masked)
Invoke-RestMethod http://localhost:3000/videos/keys

# Add another key without restart
Invoke-RestMethod -Method Post -ContentType "application/json" `
  -Body '{"apiKey":"sk-...","label":"account-2"}' `
  http://localhost:3000/videos/keys

# Clear today's exhaustion for one key
Invoke-RestMethod -Method Post http://localhost:3000/videos/keys/2/reset

# Start or resume
Invoke-RestMethod -Method Post http://localhost:3000/videos/start

# Stop new work and polling after the current request finishes
Invoke-RestMethod -Method Post http://localhost:3000/videos/pause

# Inspect up to 100 failed jobs
Invoke-RestMethod http://localhost:3000/videos/failures

# Retry one failed job
Invoke-RestMethod -Method Post http://localhost:3000/videos/jobs/123/retry

# Retry all failed jobs
Invoke-RestMethod -Method Post http://localhost:3000/videos/retry-failed
```

The worker handles only one Agnes generation at a time. Its state flow is:

`pending -> submitted -> processing -> completed -> downloaded`

It records `video_id` (and which API key created it) before polling, so a
restart resumes that Agnes job instead of submitting a duplicate. Network
failures use exponential backoff. A real quota HTTP 429 marks that key
exhausted for today and switches to the next key. New submissions pause only
when every enabled key is exhausted.

## Logging and diagnosing waits

The console and `logs/application-YYYY-MM-DD.log` now record every important
worker transition: pause/start, submitted task IDs, each Agnes poll and
progress percentage, downloads, retry time, rate limits, and daily-budget
stops. Errors are also written to `logs/error-YYYY-MM-DD.log`.

When an Agnes task is slow, expect repeated entries such as:

```text
Job 13: chapter 1, "Longitude", sentence 1 polled Agnes task task_...:
processing -> processing, remote status "processing", progress 42%, elapsed 95s.
```

This means the application is still working and waiting for Agnes. If a task
does not change after a long period, use `GET /videos/status` and inspect the
latest log entries before deciding whether to pause or retry it.

To perform a one-clip production check before spending a full day's quota, set
`DAILY_VIDEO_SECONDS=5`, restart, import, and start the worker. Restore it to
`500` only after the downloaded first clip is correct.

## Output and chapter assembly

Clips use stable ordered paths:

```text
videos/
  chapter-01/
    0001-atmosphere/
      0001-1.mp4
    manifest.json
    concat.txt
```

A manifest is rewritten after each successful download. Once every sentence in
a chapter is downloaded, concatenate it without re-encoding:

```powershell
Invoke-RestMethod `
  -Method Post `
  http://localhost:3000/videos/chapters/1/assemble
```

The result is `videos/chapters/chapter-01.mp4`. The clips must share compatible
codec settings, which Agnes normally provides. If they do not, change the
FFmpeg assembly to re-encode rather than using `-c copy`.

## Verification

```bash
npm run build
npm test
npm run test:e2e
```

Tests cover parsing, normalized deduplication, idempotent database import,
daily budget boundaries, job-state mapping, and deterministic paths. Agnes and
downloads are not called by the automated tests.

## Recovery and backups

- Keep the SQLite database and `videos` directory together when moving hosts.
- Back up the database while the service is stopped, or use SQLite's backup
  command to obtain a consistent live snapshot.
- Jobs with saved Agnes IDs are polled after restart.
- Failed downloads retain the remote URL and retry without generating again.
- Do not delete the database unless all generation progress can be discarded.

At 100 clips per day, the minimum processing time is
`ceil(total imported sentences / 100)` days. The status endpoint reports the
actual imported total and completed count.
