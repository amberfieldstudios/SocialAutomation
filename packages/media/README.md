# @social/media

Media-processing pipeline stage (`docs/ARCHITECTURE.md` §3, stage 4 of the
content pipeline). Given a source `media_assets` row, produces the
`media_renditions` a set of target platforms needs: square/portrait/
landscape/story aspect crops, a thumbnail, a compressed variant, and (for
video) resolution/bitrate selection + caption-track handling — validated
against the per-platform specs recorded in `docs/PLATFORM-RULES.md`.

## What's real vs. selection-only

- **Images**: fully real. Every rendition is produced with `sharp` — actual
  resize/crop/re-encode, actual output files, actual dimensions/bytes
  returned. No mocking.
- **Video**: target **selection** (`videoPlan.ts` — resolution, bitrate,
  which caption tracks can attach) is pure logic, has no dependency on
  ffmpeg, and is always exercised for real by the test suite via fixtures.
  Actual **transcoding** (`videoTranscode.ts`) shells out to the `ffmpeg`
  binary and is gated behind `videoCapability.ts#isFfmpegAvailable()`. If
  `ffmpeg` is not installed / not on PATH:
  - `RenditionPlanner.execute()` does NOT throw — it records the video's
    `compressed` rendition with `status: 'failed'` and an actionable message
    pointing at https://ffmpeg.org/download.html, so the rest of the pipeline
    (image renditions, validation, persistence) still proceeds.
  - The transcode code path itself is not exercised by this package's test
    suite on a machine without ffmpeg (there is nothing to run it against);
    only the selection logic is tested there.

**To get real video transcoding**, install `ffmpeg` and ensure it's on the
`PATH` of the machine/container running this package (`ffmpeg -version`
should print a version). No additional npm dependency is required — this
package spawns the `ffmpeg` CLI directly rather than depending on
`fluent-ffmpeg`.

## Usage

```ts
import { RenditionPlanner, createLogger } from '@social/media';
// createLogger is actually from @social/logging; shown for context.

const planner = new RenditionPlanner(logger);
const plan = planner.plan(sourceMedia, ['bluesky', 'discord']);
const { asset, renditions } = await planner.execute(sourceMedia, plan, '/tmp/media-out');
```

`plan()` is pure (no I/O) and safe to call repeatedly for the same inputs.
`execute()` performs the actual file I/O and is a pure
input-file -> output-file step per rendition, so the pipeline can cache and
retry it per rendition kind.

## Per-platform specs

`src/platformSpecs.ts` transcribes the Twitch/Bluesky/Discord media rules
from `docs/PLATFORM-RULES.md` verbatim (dated, cited there). Any other
platform id falls back to `DEFAULT_PLATFORM_MEDIA_SPEC`, a documented
conservative placeholder — `PlatformMediaSpec.documented === false` flags
this in validation warnings so a placeholder is never mistaken for a checked
number. When a new platform's media rules are added to
`docs/PLATFORM-RULES.md`, add its real `PlatformMediaSpec` here in the same
change.
