## Why minutes go missing

When the lyric box is empty, Auto-sync just transcribes the song with ElevenLabs and groups the returned words into lines. A gap from 2:47 → 4:34 with nothing in between means ElevenLabs returned no word timestamps in that span. Two real causes:

1. **Instrumental / bridge sections.** Scribe is a speech model. If the vocal drops out (solo, drum break, heavy mix) it correctly returns zero words there — but we silently produce nothing, so it looks like lines are "missing."
2. **`scribe_v1` accuracy on sung audio.** We're calling the older `scribe_v1` model in `src/lib/transcribe/elevenlabs.ts`. `scribe_v2` is noticeably better on music/sung vocals and tends to recover words v1 drops mid-song.

Our grouping logic in `Transport.tsx` (`GAP = 0.7s`, `MAX_WORDS = 9`) is fine — it never deletes words, it just splits them. So the fix is upstream: get more words from ElevenLabs, and visualize the spans where there genuinely are none.

## Changes

### 1. Upgrade transcription model — `src/lib/transcribe/elevenlabs.ts`
- Change `model_id` from `scribe_v1` to `scribe_v2`.
- Bump cached transcripts key so old `scribe_v1` results re-transcribe once (e.g. `transcript:v2:${assetId}`), otherwise users keep seeing the old gappy result.

### 2. Insert visible instrumental markers — `src/components/editor/Transport.tsx` (`groupWordsIntoLines`)
- After grouping, scan adjacent line pairs. If the gap between `lines[i].end` and `lines[i+1].start` is `>= 8s` (configurable), insert a synthetic line `{ time: lines[i].end + 0.2, text: "♪ instrumental ♪" }`.
- Also add a leading marker if `lines[0].time >= 8s` and a trailing one if `duration - lastLine.end >= 8s`.
- This way the gap is explicit in the lyric list and on the timeline rather than appearing as missing content. Users can delete or rename the marker line from the lyric textarea.

### 3. Small diagnostic log
- In `runTranscription`, after parsing, log word count, duration covered, and longest gap (`max(words[i+1].start - words[i].end)`). Makes it obvious in the console whether future "missing lyrics" reports are model dropouts vs. real instrumentals.

## Out of scope
- Not changing the alignment path (pasted lyrics + Auto-sync) — that uses a different code path and the user confirmed this issue is on the empty-box generation path.
- Not changing the visualizer rendering.

## Files touched
- `src/lib/transcribe/elevenlabs.ts`
- `src/components/editor/Transport.tsx`
