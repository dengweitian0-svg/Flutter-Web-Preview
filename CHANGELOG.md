# Changelog

## 0.1.6

- Let Flutter hot restart update the preview after Dart saves and explicit Reload Web Preview requests, without adding a second full-page browser reload.
- Keep Reload Preview Browser as an explicit page reload. Refresh automatically only when Flutter explicitly reports that the compiled page requires refresh or no client received the update.
- Verify visible UI updates, retained browser documents, editor focus, save deduplication, compilation error recovery, and continued application logging.

## 0.1.5

- Detect whether the Flutter SDK supports `--no-web-experimental-hot-reload`. Keep the restart-oriented compiler on older SDKs and use the SDK default when newer releases remove the option.
- Preserve existing Auto Save behavior on SDKs that support the old compiler flag; continue using full restarts for explicit preview updates.
- Check the Flutter CLI options before launch to avoid startup failures when SDKs remove a flag.

## 0.1.4

- Add **Save and Reload Web Preview** and a Ctrl+S / Cmd+S binding scoped to local Dart editors while a preview is active. Successful explicit saves update the preview even when VS Code omits the will-save notification; already saved files can also request an update.
- Deduplicate explicit saves and native save events, and discard failed, cancelled or stale-session save results. Keep `reloadOnSave` as the master switch and retain existing Auto Save filtering.
- Native Save / Save All events still require a known manual reason by default. Unknown save sources are accepted only with the existing `reloadOnAutoSave` opt-in.

## 0.1.3

- Refresh the preview on manual Dart saves by default. Add `flutterWebPreview.reloadOnAutoSave` (default `false`) to opt into refreshes triggered by VS Code Auto Save, while retaining `reloadOnSave` as the master switch.

## 0.1.2

- Serve CanvasKit locally and use the restart-oriented web compiler without Dart expression evaluation metadata to reduce startup and page refresh overhead.
- Capture browser logs without source-map parsing, script pauses for source maps, or asynchronous debugger stack tracking.
- Consume pending save debounce timers when compilation begins, avoiding a redundant compile after manual reload.
- Add a real VS Code performance test that measures time until the Flutter page visibly updates, with the log connection active.

## 0.1.1

- Keep an owned lifecycle console alive after browser closure, emit exactly one confirmed exit marker, and merge browser logs into it.
- Report cleanup failures without claiming success; preserve session isolation across Stop, Restart, and late events.

- Show Flutter Web application console logs (`print`, `debugPrint`, and `dart:developer.log`) in an automatically attached Debug Console session.
- Keep log capture across preview refreshes, and stop the preview when its owned logging session ends.
- Add Show Debug Console, recoverable log connection warnings, and isolation from unrelated debug sessions.

## 0.1.0

- Run Flutter Web inside VS Code Integrated Browser on local Windows.
- Recompile and refresh on Dart save with debouncing and serialized requests.
- Stop the managed Flutter process when the owned preview closes.
- Add project discovery, main CodeLens, commands, settings, output and status.
- Guard stale results, process cleanup and unavailable browser tab ownership.

