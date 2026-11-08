# Alpha implementation checklist

Engine-scope update, 2026-11-07: the user now wants usage-based assisted-update priorities and explicitly excludes Others/unknown engines from assisted updates. See [internal engine priorities](engine-priorities.md) for the supplied counts and proposed tiers. This supersedes the earlier unconditional all-engine assisted-update target below; named rare-engine exclusions are recommendations pending adoption. Unknown engines and recognised patch archives now use manual installation.

Updated 2026-11-07. A usable local Electron prototype now exists, with user testing of F95 login/browsing, downloads, extracted macOS Ren'Py imports and forum linking. The current priority is validating the complete real-game install/update/save-preservation cycle. The agreed scope below remains the target; implementation and fixture coverage are not evidence that every alpha requirement has passed real-device testing. See README.md and testing-status.md for current capabilities and evidence.

## Current milestones

| Area | Current position |
| --- | --- |
| Setup and browser | First-launch setup, games root, download mode, retention preferences, persistent login, tabs and popup handling implemented. User has logged in and browsed/downloaded through the app. |
| Library and metadata | Folder/archive discovery, extracted .app imports, thread search/linking, local release evidence, forum details and cached covers implemented. User has exercised imports and thread matching/linking. |
| Downloads | Queue, attribution from originating threads, new-game association, reveal, retry/cancel and list dismissal implemented. Real downloads exercised; provider expiry, multipart grouping and exit-page fallback still need work/validation. |
| Update checks | Incremental feed checkpoints, changed-thread verification, full checks, overdue reconciliation and incomplete-check reporting implemented. Fixture/native transport coverage exists; the revised live F95 check still needs user validation. |
| Installation and updating | ZIP staging, external-extractor handoff/output selection, save/preferences-only transfer, launch registration, archive cleanup and managed old-version retention implemented. A complete real-game update with verified saves remains the main milestone. |
| Engine coverage | Ren'Py has priority and save-transfer fixtures. Other named engines remain alpha scope with experimental rules, metadata/custom-layout gaps and real-game validation outstanding. Managed HTML origin/profile persistence is unfinished. |
| Library management | Startup reconciliation preserves records for missing/offline games and discovers recognised extracted games. File deletion can be done in Finder/Explorer and reconciled on the next startup/scan; an in-app file deletion interface is deferred. |
| Distribution | Windows/macOS x64 and ARM64 targets configured. GitHub CI builds macOS ARM64/Intel and Windows x64 packages. Tagged builds publish prereleases; Windows uses a web bootstrap installer with a separate release payload. Publisher signing/notarization, a macOS bootstrap and application self-updates remain outstanding. |

Current automated evidence: 146 regression tests, syntax checks and 36 native Electron scenarios passed on macOS ARM64 on 2026-11-08. These use synthetic/local fixtures, including authenticated loopback requests and an actual-main IPC/HTTP integration, and do not establish real-game save compatibility or live provider/feed behaviour. RPG Maker default transfer rules now include MV/MZ packaged-content layouts and older-edition root slots; real-game validation remains outstanding. AfterShelf branding, native icon exports, profile continuity and update-only Dock badging are implemented. F95/LC source routing, browser shortcuts, site/feed status, separate endpoint settings, source labels and source-scoped logout are wired. The supplied LC URL is configured, and the user confirmed its rendered first-page listing check succeeded with 60 entries at 11:18 AM on 2026-11-08. Live LC thread/version verification, pagination and download/install acceptance remain pending.

## Next implementation and validation order

1. Exercise a complete Ren'Py journey on macOS ARM and Windows: fresh compressed download, extraction, registration and launch; create progress/preferences; install another full release separately; verify only saves/preferences transfer; launch and load progress; then confirm archive cleanup and the selected old-version retention. Include failed/cancelled work and external extraction. No backup/restore feature is introduced.
2. Finish the remaining download and library-management work: exit-page attribution fallback, multipart context/grouping, interrupted/expired-link recovery, save-preserving uninstall/file deletion, and locate/reconcile handling for moved or offline installations.
3. Build and exercise a real-game test matrix for every agreed engine family, with Ren'Py first. Complete the managed HTML origin/profile handling and individual engine/custom-layout gaps revealed by those tests.
4. Polish the app/site theme and remaining UI, then build and test distribution packages for the agreed architectures. Configure bootstrap downloads and GitHub releases/application updates, recording signing/notarization and untested-device status accurately.

## Settled decisions

- Independent Electron implementation, inspired by F95Checker's features rather than copying its source. No Qt.
- Windows and macOS, Intel x64 and ARM64 targets. “x86” is interpreted as Intel x64. User testing is available on Windows and macOS ARM; record actual tested architectures. Linux is not in the current alpha scope.
- All named engine families in application-spec.md are in scope, including older RPG Maker, WOLF, KiriKiri, and HTML story formats. Ren'Py takes priority; do not reduce alpha scope to Ren'Py-only. Some rules still need research/implementation, so support is a target, not a completed claim.
- All game downloads are compressed; ZIP is the primary format. Know the engine before download/extraction from thread tags or the prior installation. User-selectable default external extractor handles passwords/multipart formats and replacement prompts. Default downloads, extraction, and output-folder selection to the chosen games directory. Use completion reporting or select extracted output before applying the known save/preference rules. Patches and executable installers are manual-only and labelled unsupported for assisted installation.
- Download origin tracking through thread → exit page → host → file. Thread ID is primary; exit-page game title corroborates or provides fallback attribution. Ambiguous matches need selection. The supplied signed exit URL is not stored in project documents or logs.
- Bounded retry and clear/remove for failed jobs. Expired links can be reacquired through the ordinary game/thread download flow. Download completion is distinct from installed-version completion.
- Keep the original installation until extraction and saves/preferences-only transfer complete. Enforce sequential per-game operations. No backup, snapshot, restore, or general rollback subsystem.
- Automatically delete the job's compressed files after confirmed installation/update. Keep archives and their Install/Update action for download-only, failed, cancelled, or unconfirmed work. An external extractor completing after app exit is handled by resuming that archive's Install/Update action, accepting its completion report or selecting the extracted folder, and finalizing save transfer and launch paths. The app does not supervise the external program's lifetime.
- Quit on window close. Warn only for active downloads/app-managed updates; closing cancels that work. A separate external extractor may continue independently. Visible update-scanning indicator; checks only while app runs.
- Eventually use GitHub for packages/releases/app updates. Plain .txt diagnostics with Copy and Save; no automatic upload.

## Implementation and live checks

1. Inspect the actual logged-in site's current theme and match it in the app shell.
2. Verify login/session lifecycle. Validate exit-page HTML later in the embedded browser, as agreed; do not treat this as a prerequisite to implementing the rest of the workflow.
3. Verify attribution across multiple game tabs, host popups/redirects, duplicate names, and multipart files. Confirm release/platform when the downloaded build is ambiguous.
4. Implement each named engine rule, including missing research for old RPG Maker, WOLF, KiriKiri, and non-SugarCube Twine formats. Record engine-rule version and known gaps in diagnostics.
5. Exercise ZIP and external-extractor workflows using the engine known before download. GUI launch/process exit is not proof of completed extraction; accept a supported report or an output selected from the chosen games directory. Test repeat extraction/replacement prompts, completing extraction after app quit, and resuming the retained archive's Install/Update action without redownloading. Unsupported patch/installer paths remain manual.
6. Verify old files survive failed/cancelled extraction or save copying. Do not switch installed-version state early. Never copy old program content/mods into the new release.
7. Exercise no-local-save external rules without prompting, first play/no saves, local preferences without local saves, and unreadable paths. External saves stay in place without snapshots.
8. Verify retry, clear, explicit file deletion, partial-download handling, and return-to-thread recovery. Failed downloads do not clear update availability.
9. Verify choose-root defaults for downloads/extraction/output selection, import/manual registration, Play, file reveal, offline drives, old-version retention options, automatic archive cleanup only after confirmation, independent cleanup retry, and save-preserving uninstall without backups.
10. Verify close warnings only during active downloads/updates, cancellation before quit, and visible update-scan state. A failed metadata scan does not empty the library.
11. Validate .txt export contains useful stage/error detail and no cookies, tokens, passwords, or signed-link values.
12. Produce architecture-specific packages, record actual device results, and configure GitHub distribution when available. Signing/notarization can be addressed for the chosen distribution route rather than becoming an additional product feature.

## First alpha journey

Choose games root → log in → browse/add thread and engine → follow its exit page and chosen host → download compressed release to games root → reveal/manual install or extract → confirm output → transfer applicable saves/preferences → set launch path and confirm installation → automatically remove the archive → launch/save/close → detect update → download user-chosen release → extract separately → transfer only saves/preferences → switch installation → automatically delete archive and optionally delete old release. An unconfirmed extraction remains resumable from its downloaded archive. Errors can be retried, cleared, and exported as text. No restore step exists.

## References

- [Application requirements](application-spec.md)
- [Engine research and current evidence](engine-save-research.md)
- [Electron download controls](https://www.electronjs.org/docs/latest/api/download-item)
- [Electron file reveal](https://www.electronjs.org/docs/latest/api/shell#shellshowiteminfolderfullpath)

Alpha scope clarification, 2026-11-08: the user confirmed the revised update check appears fixed. Await an actual new game release for the remaining real save/update cycle. Ship general named-engine profiles as experimental and collect diagnostic bug reports. Use startup folder reconciliation for the selected games root, retain missing-game records and hide redundant installed-game archives in scan results. Downloads remain user initiated; external extractors handle multipart/password archives. Failed/expired transfers return to the thread and remove partial data. Publish a clean public AfterShelf repository with local data excluded and builds for macOS ARM64, macOS Intel and Windows Intel/AMD x64.
