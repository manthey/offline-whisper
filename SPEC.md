# Spec: Transcribe Audio Files Embedded in a Note

## Intent (read this first — a previous attempt got it wrong)

**EXTEND the existing plugin. Do NOT rewrite or replace it.** The existing
live voice-transcription functionality and its architecture are deliberate and
must be kept intact:

- **whisper.cpp binary downloading into the plugin folder** (`<pluginDir>/bin`)
  on desktop — this was explicitly called out as "really nice".
- **Model downloading/caching** from Hugging Face into `<pluginDir>/models`
  (`MODEL_MAP` in `src/desktop-transcriber.js`), plus the settings-tab
  "Check model cache" / "Clear Cache" buttons.
- **Mobile support** via `@huggingface/transformers` (WebAssembly) — keep
  `isDesktopOnly: false` in `manifest.json`. The new feature must also work on
  mobile through the same transformers.js path.
- **Chunking** (MediaRecorder chunks, ordered insertion via
  `pendingResults` / `nextInsertChunk` / `flushPendingResults`).
- **Regex filter** for transcribed fragments (`settings.regexFilter`,
  applied in `flushPendingResults`).
- Existing commands (toggle/start/stop transcription), the existing mic
  ribbon icon, wake lock, status notices, and all existing tests.

The new feature is _additional_: transcribe an audio **file** that is embedded
in the current note (`![[recording.m4a]]`) and write the transcript directly
beneath the embed, **using the same transcription engines** (whisper.cpp on
desktop, transformers.js on mobile) — not an external shell command, not a new
dependency.

## Repository facts

- Plain JavaScript (ES2020, CommonJS). **No TypeScript.** Entry: `src/main.js`;
  desktop engine: `src/desktop-transcriber.js`. Bundled by `build.js`
  (esbuild, platform `browser`, `obsidian` external) to `main.js`.
- Because of `platform: 'browser'`, Node builtins are not importable directly.
  `src/desktop-transcriber.js` accesses them via the
  `new Function('moduleName', 'return require(moduleName)')` trick
  (`getNodeModules()`). Reuse that pattern if Node access is ever needed;
  prefer Obsidian APIs (`vault.adapter.readBinary`, `FileSystemAdapter`)
  where possible.
- Platform detection: `isMobilePlatform` checks `process.versions.electron`;
  tests override via `globalThis.__desktopOverride`.
- `npm run build` builds; `npm run tests` runs desktop (nyc) + jest + mobile
  (playwright) tests; `npm run format` runs prettier. Existing tests use
  `tests/obsidian-mock.js` and `tests/transformers-mock.js`; extend them
  rather than deleting anything.
- Style: match the existing code (2-space indent per prettier config,
  `log()` helper for console logging, `showStatus()` for notices).

## Existing transcription pipeline (reuse it)

`loadModel()` (in `src/main.js`) sets `this.transcriber` to a function
`(audioData: Float32Array @16kHz mono) => Promise<{text}>`:

- Desktop: `DesktopTranscriber.initialize(modelId, progressCb)` downloads the
  whisper.cpp binary + model if missing; `transcribe(audioData)` writes a temp
  16 kHz WAV and spawns `whisper-cli -m <model> -f <wav> -nt -np`.
- Mobile: transformers.js `pipeline('automatic-speech-recognition', modelId)`.

`transcribeAudio()` already shows how to turn a Blob into `audioData`:
`AudioContext.decodeAudioData` → channel 0 → resample to 16 kHz
(`resampleAudio`) → clamp to [-1, 1]. For a file embed, read the bytes with
`app.vault.adapter.readBinary(file.path)` and follow the same path. (For very
long files, chunk the decoded Float32Array rather than sending it all at
once — especially on mobile. Keep this simple.)

## New feature requirements

### Shared constant

```js
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'ogg', '3gp', 'flac', 'webm'];
```

An audio embed is a `.internal-embed` element whose `src` attribute ends in
one of these extensions, or a `![[...]]` link in the note text whose target
(strip any `|alias`) ends in one.

### Triggers — all call the same `transcribeFile(linkpath)`

1. **Inline button.** Append a small `<button>Transcribe</button>`
   (class e.g. `transcribe-audio-btn`) to every audio `.internal-embed` in the
   active note. Reading view: `registerMarkdownPostProcessor`. Live Preview:
   the post processor does **not** run for these embeds, so also run the same
   button-adding function over the editor DOM from a `MutationObserver`
   created in `onload` (observe `document.body`, childList+subtree) and
   disconnected in `onunload`. Skip embeds that already have the button.
   Minimal CSS in a root `styles.css` (small button, below/beside the player).
2. **Right-click menu.** `registerDomEvent(document, 'contextmenu', ...)`: if
   the target is inside an audio `.internal-embed`, `preventDefault()` and
   show an Obsidian `Menu` with one item, **Transcribe**. (The three-dot menu
   inside the audio player is Chromium's native control menu and cannot be
   extended — this replaces that need.) Note: current `obsidian` typings
   declare `new Menu()` with no constructor argument.
3. **Command palette.** Command **Transcribe audio in this note** (no default
   hotkey): find all audio embeds in the active note's text
   (`![[...]]` with audio extension), show a `FuzzySuggestModal` (display the
   filename), Enter calls `transcribeFile(linkpath)`. If none, `Notice` and
   stop.
4. **Sidebar / ribbon button.** A **second** ribbon icon (the mic one already
   exists for recording — use a distinct icon such as `file-audio`) that opens
   the same picker modal as the command, listing the audio files linked in
   the currently selected note.

### `transcribeFile(linkpath)` behaviour

1. Guard: only one file transcription at a time; if one is running, `Notice`
   and return. (Don't block or interfere with live recording state.)
2. Resolve: `app.metadataCache.getFirstLinkpathDest(linkpath, activeFile.path)`.
   Use `app.workspace.activeEditor.editor` for edits; `Notice` if no active
   note, file not found, or embed line not found.
3. Find the first editor line containing `![[` + linkpath.
4. **Existing transcript check.** If the first non-blank line after the embed
   line matches `^#+ Transcription\s*$`, ask "Replace existing transcription?"
   with a minimal modal (Replace / Cancel). Cancel → stop. Replace → the old
   section (heading through the line before the next heading of any level, or
   end of file) is replaced by the new one; keep the old text so it can be
   restored on failure.
5. **Placeholder.** Insert directly below the embed line, with a blank line
   before it: `<# repeated headingLevel> Transcription`, blank line,
   `_Transcribing..._`.
6. Ensure the model is loaded (`await this.loadModel()`), then decode and
   transcribe the file with the existing engine as described above. Show
   progress via the existing `showStatus()` where practical.
7. **On success:** replace the `_Transcribing..._` line with the trimmed
   transcript text (apply the configured regex filter consistently with live
   transcription, or leave the whole transcript if it would be filtered
   entirely — pick the simple option and note it). `Notice('Transcribed')`.
8. **On failure:** remove the placeholder section (restore the old section if
   replacing) and `Notice` the error message. The note must be unchanged.
9. Re-locate the placeholder by searching the editor text for
   `_Transcribing..._` when transcription finishes — the user may have edited
   the note meanwhile. (Placeholder block is: embed line, blank, heading,
   blank, placeholder — so the block ends at the placeholder line and starts
   at the end of the embed line.)

### New setting

- **Heading level** (dropdown or number, 1–6, default 2): number of `#`
  characters in the heading written above each transcript. Add to the existing
  `WhisperSettingTab`; persist via the existing `loadSettings`/`saveSettings`.
  Heading text is fixed: `Transcription`.

### Resulting note format

```
![[Recording 20261020.m4a]]

## Transcription

So basically the idea is that I can speak instead of typing...
```

## Acceptance criteria

- All pre-existing behaviour and tests still work unchanged (recording,
  chunking, filters, caching, mobile build, `npm run tests` passes).
- Clicking the inline button on an `.m4a` embed inserts a placeholder, then
  the transcript, under that embed — in both Live Preview and Reading view.
- Right-clicking the embed shows **Transcribe**, which does the same.
- The command palette command **and** the new ribbon button list the note's
  audio files; Enter transcribes the chosen one.
- Changing the heading level setting changes the number of `#` on the next
  transcription.
- Transcribing an already-transcribed embed asks before replacing; Cancel
  leaves the note untouched.
- A failing transcription leaves the note unchanged and shows an error notice.
- Works with several audio embeds in one note; each transcript sits under its
  own embed.
- Desktop uses the downloaded whisper.cpp in the plugin folder; mobile uses
  the cached transformers.js model. No new runtime dependencies.
