# Changelog

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

