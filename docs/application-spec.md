# AfterShelf requirements

Working specification, updated 2026-11-08. AfterShelf is the agreed application name. This records the full agreed product direction. A first runnable Electron foundation is now implemented; see README.md for current capabilities and incomplete alpha features. F95zone remains the primary live development/testing target. LewdCorner is wired as the second source; the user has confirmed live first-page listing extraction, while thread/version and download/install acceptance remain pending.

## Product and implementation

Build an independent Electron application inspired by F95Checker's feature set and workflow. Do not copy its implementation or introduce Qt/Python as inherited runtime requirements. Windows and macOS are the alpha platforms; Linux is outside the current build scope.

Target Intel x64 and ARM64 packages on each platform. This interprets the user's “x86” as Intel x64 rather than 32-bit x86. The user can locally test Windows and macOS ARM; record the actual Windows architecture tested. Intel macOS and any other untested target still get build targets, with test status recorded accurately.

Engine coverage is being prioritised using the user-provided F95 catalogue counts in [internal engine priorities](engine-priorities.md). Ren'Py remains first. The previous unconditional all-engine assisted-update alpha target is superseded by this scope review. Others/unknown engines must remain manual-only, as explicitly requested; never infer a generic automated save-transfer rule for them. Recommended next targets are RPG Maker and Unity, followed by HTML, with rarer families considered later. Those tier boundaries are planning recommendations; runtime enforcement of the unknown-engine exclusion remains implementation work. Manual handling retains library metadata, update notifications, downloads and registered launches. Engine research is not evidence of completed or tested support.

Ren'Py save handling (user clarification, 2026-11-08): copy all files present in the old local saves folder into the corresponding folder of the new release. A missing or empty local saves folder means there is no local save data to transfer, so continue the update and leave external saves untouched. Do not add save-location prompts, identity checks or local/external reconciliation as prerequisites for this flow.

RPG Maker uses the same rule (2026-11-08): copy the edition's existing local save/preferences files into the corresponding locations in the new release. MV/MZ check `save/` and `www/save/`, including those relative to packaged content located by the edition's core script. XP, VX, VX Ace and 2000/2003 check their edition-specific root-level slot files, with existing `Save`/`save` folders also handled by the XP/VX profiles. Missing or empty local saves do not block completion or trigger an external-save search/confirmation. Preserve entire identified save folders, including global/configuration data; never merge old game databases, scripts or launch configuration into the new release. Runtime rules have synthetic fixture coverage; real-game validation remains outstanding.

## Interface and theme

Match the site's actual XenForo theme: colours, typography, navigation, panels, buttons, borders, spacing, badges, and thread-style lists. Inspect the rendered active theme before implementation. Reproduce its visual language in local app styles. The actual forum retains its website styling and selected site theme; app sections should feel adjoining. Offer a corresponding app theme selection and a manual override where automatic theme matching is unavailable.

Library items expose Play, Open thread, version/update status, and Delete/uninstall. Downloads expose progress, retry, clear/remove, installation actions, and Show in Explorer/Finder. Include a visible update-check indicator, with checking, completed/last-checked, and error states. Do not expose backend implementation details in ordinary flows.

The sidebar identifies the selected section; omit large repeated page titles, taglines, and introduction blocks. Keep actions compact. Browse uses the full content area with a slim tab strip and navigation toolbar, without a visible URL/address field or repeated app header/footer. Provide new/close/switch-tab controls plus Ctrl/Cmd+T and Ctrl/Cmd+W. Open permitted popup windows and new-window links as internal tabs sharing the forum session and originating download context; continue blocking known advertising hosts and non-web protocols.

## Browsing and update discovery

### Multiple website sources (2026-11-08 direction)

The application is branded AfterShelf, independent of a particular forum. Limit source integrations to F95 and LewdCorner; the user has dropped the other proposed communities. Both are wired without changing a global forum setting to reassign an entire library. F95 remains the primary live development/testing target. The user supplied LC's latest-updates URL; its configured default is `/latest-updates?page={page}&per_page=60&cat=Games&search_scope=title&ignored_mode=hide&only_new_days=7`. Its raw HTML contract is not live-validated by these tools. After the user reported a reachable site with an unrecognised listing, HTML adapters gained a rendered-page fallback for JavaScript-populated or image-linked listings. It uses the existing forum session in a temporary sandboxed browser window; it does not retry authentication challenges, navigate away from the configured listing/page, allow popups/dialogs or retain raw HTML. Background downloads are cancelled before the game download manager sees them. Timeouts and cleanup are bounded. This path is locally validated against a JavaScript-populated fixture; the user subsequently confirmed the live rendered listing check succeeded with 60 entries at 11:18 AM Asia/Manila on 2026-11-08. This does not yet verify live LC thread/version checks or downloads.

- Each source has a stable ID, display name, base URL and adapter configuration. Each game uses one source: the website it was downloaded from, or last successfully updated from. Check that source's latest-updates section and linked thread only. Existing origin/thread fields form the identity; preserve them when migrating the current single-site settings. If the user explicitly associates a different site's download with an existing game, commit the new source only when that installation/update succeeds; cancelled or failed work keeps the prior source.
- The selected browsing source is a default for new navigation and additions; it must not reassign existing games. Metadata fetches, update checkpoints, downloads and thread navigation use the game's recorded source.
- Numeric thread IDs are only unique within their source. Matching thread numbers or similar game titles across sites must not merge library entries. Do not aggregate multiple sources or pick whichever site reports a newer version for an individual game.
- Keep each source's authentication state isolated. Login or scan failure at one source must not discard another source's games, versions or successful checkpoint. Route popup/download context through the originating source as well as the game.
- Reuse XenForo parsing where applicable, but give each adapter its own engine-tag mapping, release extraction and update-discovery method. Do not assume F95's latest-updates endpoint exists elsewhere or treat new replies as proof of a new game release.

Keep adapters specific to the two agreed sources. Reuse their user-accessible latest-updates sections and thread parsing; do not assume XenForo provides a universal unauthenticated game-update API.

Implemented controls: Open F95 / Open LC in Library and Browse, source badges on grid/list/details views, per-source endpoint/format settings, reachability/feed checks and source-scoped logout. The upper-right header always shows both F95 and LC with independent last-checked health dots and descriptive tooltips; selecting a browser tab does not hide the other source. Clicking either indicator opens that source. F95 uses its JSON listing; LC defaults to HTML parsing with same-origin thread validation, deduplication and rejection of login/challenge/unrecognised pages. Source checks do not run automatically at startup. Keep the existing Chromium profile so both domain-scoped sessions persist; clearing one origin must retain the other's login. Ordinary checks process every configured source with linked games, retaining a separate scan result and checkpoint. A seven-day feed gap can require Check all linked threads.

The macOS Dock badge is the count of installed, linked games with a known newer release. Inventory size, uninstalled games, unknown versions and ambiguous version differences do not contribute. Clear the badge at zero and refresh it at startup and whenever library state changes, including successful installation or removal.

### Current browsing and update requirements

- Users log in on the actual website in an isolated, persistent Electron browser session. Support logout and reauthentication.
- Add a game by forum thread; use its numeric thread ID as stable identity. Store thread URL, title, engine, latest reported release, selected download release, and installed release separately.
- A download from an unregistered thread creates a not-installed library entry using its recorded thread context; browsing alone does not add games. A matching thread ID reuses its existing entry. Unattributed downloads offer Add as new game or an existing library game, including in an empty library. Label first installations separately from updates based on the presence of an installation, not simply a library entry.
- Poll Latest updates incrementally with overlap/deduplication. Commit checkpoints after successful processing and reconcile periodically for missed/unpromoted changes. Only check while the app is running.
- Use recent entry fingerprints for the incremental frontier so missing/unrecognised timestamps cannot cause false success or endless catch-up. Seek distinct anchors from the previous page tail; an early old/pinned row alone is insufficient. Clear search filters from update-feed requests. Reject malformed, unexpectedly empty and repeated pages without advancing the successful checkpoint. A bounded catch-up gap exposes Check all linked threads instead of silently skipping history.
- Treat changed feed entries as candidates keyed by thread ID, then fetch those linked threads to verify the actual current release. Preserve installed versions and existing covers; ordinary checks do not download covers. Retain conflicting duplicate candidates for verification rather than selecting only a potentially misleading timestamp. If a numeric feed release is ahead of the thread response, retain a retryable incomplete check. Reconcile overdue threads in oldest-first batches of up to five per normal check once their last verified version is at least 24 hours old. This is a batch eligibility interval, not a guarantee that every large library is fully revisited within 24 hours.
- First establish a baseline for linked games lacking a verified version; retain separate timestamps for the successful global check and per-thread verification. Check all linked threads explicitly verifies every linked game, taking a feed-head snapshot before the thread reads to establish the next frontier. Partial successes can update their game records, but any failure retains the previous completed checkpoint/time. If the feed fails during a forced full check, direct thread results may still be applied with the feed failure reported. Unknown installed versions and unlinked games remain explicit in the result summary. Closing during a metadata check does not add a quit warning, but the next launch identifies the interrupted check.
- Clicking a game opens its thread. The user chooses the hosting provider and build, completes host interactions, and starts the download. No unattended game downloading or installation.
- Open external hosts without losing the originating forum page. Filter unwanted popups/navigation while permitting legitimate authentication, exit-page transitions, redirects, and CDN downloads. Remote website code has no access to app filesystem commands.
- Keep cached library details and local Play actions available when the site is unavailable. Version strings are developer labels, not necessarily semantic versions.

## Download attribution and queue

Capture a download context when leaving a game thread: library thread ID, thread title, known engine and remembered engine rules, reported release, source view, and the user-selected destination. Resolve the engine from thread tags or the stored installation before downloading; do not wait until extraction to begin engine discovery. Propagate this context through the forum exit page, host views, and popup/redirect transitions. Bind each download to that context, never to whichever game is selected when the transfer completes. Inspect extracted metadata only to refine/validate the expected engine layout and launch target.

The user reports that forum /dl/ exit pages include the game title. Use that title to corroborate the originating thread association and as a fallback when the origin is unavailable. Normalize display differences cautiously; ambiguous names require a game choice. The /dl/ numeric path is not assumed to be the thread ID, and a title does not prove which version/platform the archive contains. Multipart downloads can share the originating game's job context.

Reference example: thread 321809 and exit-page path /dl/22149368/. The supplied signed exit URL is deliberately not stored here. Exit-page HTML validation is deferred until later testing in the app's logged-in browser; it is not a prerequisite for recording or implementing the current workflow.

Provide a persistent list of queued, downloading, completed, failed, and cancelled items, with progress and useful errors. Offer retry plus clear/remove for failed or cancelled entries. Clearing a record does not remove an installation, mark a release installed, or silently delete a downloaded file; file deletion is explicit. Never install a partial download.

Expose Remove from list on non-active records and Clear completed for downloaded/installed records. These actions dismiss queue history only and leave archives, installed games, and saves untouched. Exclude active downloads and installation work from bulk dismissal.

All game downloads arrive compressed. Keep each completed archive, its game/engine context, and its Install/Update action in the downloads list until the app confirms installation completed. If the app closes during external extraction, keep the archive as downloaded / installation not confirmed, rather than pretending that the download itself failed. On reopening, the user can click Install/Update again against the same archive without downloading it again. Accept an extractor's supported completion report or let the user select an already-extracted output. Re-extraction into an existing uncommitted destination may trigger the extractor's replace-files prompt; that interaction belongs to the extractor. The old active release remains a distinct source until saves/preferences have been copied and the update committed.

Retry the current download with bounded attempts where possible. If a link expired or the host cannot resume, allow the user to clear the job and return to the game's thread to choose a fresh download normally. Do not clear Update available until installation succeeds or the user explicitly registers a manual installation. Do not promise resume support for every host.

## Games folder and existing installations

First launch opens a compact setup flow: select the games root; choose Download only or Assist with installs & updates; choose old-version retention; optionally configure an extraction application; and optionally scan for existing games. Download only is the default. Assisted mode offers installation after an associated download completes, still requiring user-selected downloads and installation confirmation. Allow skipping setup, retain a setup reminder in Library, and expose setup and folder discovery again in Settings.

Folder discovery is read-only and bounded. Review candidates before importing, avoid already registered installations, and do not follow symlinks into other directories. Existing games can be imported without a forum link and linked later; never invent thread associations from folder names. Importing records the existing location without extracting, moving, or deleting files.

Treat the selected games directory as a collection, not a single installation inferred from loose HTML or executable files. Recognize extracted macOS .app bundles inside it and nested release wrappers; documentation or helper launchers must not hide those bundles. Use the application itself as the installation root and launch target. Preselect launchable extracted games; leave archive imports opt-in so an extracted game and its retained archive do not automatically produce two library entries.

Include compressed archives in discovery results, clearly marked Not installed. Importing an archive creates a pending library entry and reuses its completed download record, or adds a download record if none exists. Do not claim an installed version or launch path before extraction and installation succeed. Show editable filename-derived titles only as suggestions; never silently match archives to existing games by similar titles. Skip known incomplete transfers and already-associated archives, which remain accessible in Downloads.

Users select a games folder on their device during setup. Compressed downloads default directly to this folder. Extraction destinations and the fallback extracted-folder picker default to this same folder, including on external drives; use a known job-specific output beneath it when available. Do not default these actions to the OS Downloads folder or an unrelated last-used directory. Example layout:

```text
<chosen games folder>/
  <downloaded-game-archive.zip>
  Games/<thread-id>-<name>/versions/<installation-id>/
  .library/staging/
```

Store library metadata/configuration in the app data directory, with relative installation paths where practical. Do not relocate engine-managed external saves or preferences merely because the games root changes.

Scan the selected root for existing installations. Let users link other existing folders without moving them, select a launch target, and associate a forum thread. Preserve externally changed paths through Scan/Sync folder and locate actions. New candidate folders do not become managed deletion targets until registered.

Root changes can apply to future installations or explicitly migrate managed files. Offline drives remain registered and marked offline. Check destination permissions and free space; do not silently fall back to the system drive. Account for the old installation remaining present during extraction of the new one.

## Library metadata and images

Forum fields retained in the local library are origin, numeric thread ID, canonical thread URL, title, detected engine, current forum release, developer/creator, tags/labels, an overview excerpt (up to 400 characters), cached cover image, last-check timestamp, parser revision and cover status/error. Installed release/provenance, installation and launch paths, previous installations, and save/preferences rules remain independent local data. Do not replace the installed release with the forum's current release when refreshing metadata.

Prefer the thread starter's opening post explicitly; selector priority must not depend on document-order unions that can pick unrelated wrappers. Remove scripts, styles, templates, quote blocks and controls from overview text. Support lazy images, lightbox full-size attributes, srcsets and attachment links. Try a bounded number of valid image candidates, using the configured forum origin as the image referrer. Persist a useful cover failure reason instead of silently leaving an unexplained empty image; include it in diagnostics. Hide previously cached lightbox configuration text and prompt for refresh, preserving the thread link and installation.

Read installed-release evidence from the actual installation without running game scripts or decoding executable serialized data. Prefer a literal Ren'Py config.version where available; macOS app release metadata can be a fallback. Record the source, preserve raw developer labels, and keep manual overrides. Build timestamps, Ren'Py runtime/script compatibility versions, the forum's latest release, and similar filenames are not evidence of the installed release. Unknown installed versions remain unknown rather than implying an update is available.

Compare clear dotted numeric releases numerically, tolerating an optional v prefix and trailing zero components. Do not flag an older numeric forum version as an update. Keep letter-suffix variants, chapter labels and packed strings such as 01551 explicit as Version differs when ordering is uncertain, rather than declaring them newer. Unknown releases cannot establish update availability.

Imported games can search forum titles through the configured site's metadata endpoint. Present candidate titles, creators, releases and thread IDs for confirmation, with a thread-preview action and manual URL fallback. Linking fetches the title, engine, current release, creator, description and available cover. Preserve the imported game's stable ID, installation, installed release and save overrides. Merge a duplicate pending entry only by confirmed thread identity, reassigning its downloads; do not silently replace a different installed game.

Refresh library details rereads local evidence and refreshes already linked forum details, with a visible progress indicator. Covers are bounded raster downloads, resized and cached locally for display without direct renderer network access; signed cover URLs are not retained. Retain existing images if refresh fails and offer retry. Keep the monogram until a cover is available. Keep this separate from efficient incremental latest-update checks.

Thread metadata requests share the forum's Chromium session and follow validated same-origin redirects from numeric thread URLs to their canonical slugs. Validate each redirect before following it, bound redirect chains and response size, and require another confirmed match if the destination changes thread identity. Cover redirects use image URL validation, and a failed cover fetch must not prevent linking successfully retrieved thread metadata. Electron's [ClientRequest redirect event](https://www.electronjs.org/docs/latest/api/client-request#event-redirect) supplies the required synchronous redirect control; do not assume session.fetch with manual redirect mode exposes a readable 3xx response.

## Archives, extraction, and manual installation

Every game download enters the workflow as a compressed archive, with ZIP the primary format. Use the engine already recorded from thread tags or the installed version to choose the post-extraction save/preferences and launch-path workflow. Let the user select a preferred external extraction application or use the OS default association. Invoke that program with the selected archive using validated paths/argument arrays and supply the selected games folder/output destination when the integration supports it. Do not require users to install a toolchain or build a replacement for WinRAR, 7-Zip, The Unarchiver, or OS extraction tools.

Password-protected, multipart, and other formats may be handed to the configured application. That program handles passwords, replacement prompts, and format-specific interaction. Use a supported completion/output report where available; otherwise show Select extracted game folder, initially at the chosen games directory or this job's known output within it. A GUI extractor exiting or opening does not establish that extraction finished successfully. Once output is identified, apply the known engine rules, transfer only saves/preferences, update launch paths, and confirm the installation. Read passwords only in the extraction program, never in diagnostics.

Label incremental patches and executable installers as unsupported for assisted installation. They require manual installation, with Show in Explorer/Finder and Locate installed game available. Do not silently execute them or treat a patch as a full release.

Completed downloads expose:

- **Install / Update:** use the supported ZIP workflow or configured external extractor followed by selection of its output.
- **Show in Explorer / Show in Finder:** reveal the archive, selecting it where supported.
- **Locate installed game:** register an installation the user completed manually.

Download-only does not extract or alter installations. Download completion alone never marks the latest release installed. Report moved/missing files and offer to locate them. [Electron file reveal API](https://www.electronjs.org/docs/latest/api/shell#shellshowiteminfolderfullpath).

## Launching

Provide Play with an editable target, working directory, argument list, and optional compatibility runner. Support Windows executables, macOS application bundles, and appropriate HTML entry points. Preserve bundle structure and executable permissions. A missing target offers Locate installed game. Do not assume a Windows-only build runs natively on macOS, or that all x64 games work on ARM without appropriate OS compatibility.

Keep managed HTML games on a stable, game-specific origin and persistent browser profile outside replaceable version folders. Separate this storage from forum/download sessions. External-browser mode is possible, but the app does not automatically control that browser's saves. Do not automatically launch a newly downloaded game.

## User-requested update sequence

1. Associate the completed archive with a game/release/build and distinguish full releases from unsupported patches/installers.
2. Ensure the old game is closed. Resolve the remembered save/preference plan and successfully inspect relevant paths.
3. Extract the new full release into a different directory, leaving the original installation untouched. External extraction requires confirmation/validation of the output folder.
4. Copy only identified saves and game preferences from the old release into the new one. Keep the source copies intact until transfer completes. Leave external save directories, registry state, and browser storage in place. Do not create snapshots or backups.
5. Verify extraction, save/preference transfer, and the launch target. Commit the active installation and installed release only after these succeed.
6. Automatically delete this installation job's compressed archive(s) after the new installation, launch path, installed-version record, and save/preferences transfer have been confirmed. Apply the user's old-version retention choice separately. Failed/cancelled or unconfirmed work retains the archive and previous installation so Install/Update can be retried from the downloads list. If archive deletion fails, keep the successful installation and report a cleanup retry; never repeat extraction merely because cleanup failed.

Fresh program content comes from the new release. Never merge/mirror the old installation or copy old scripts, binaries, libraries, assets, plugins, mods, caches, or other unrelated files into it. Users acknowledge possible save incompatibility. There is no backup or restore feature.

Operations follow this order in the UI. Only one conflicting installation/update/delete operation can run for a given game. Keep this simple; a general backup/rollback subsystem is outside scope. If a job is interrupted, do not treat its unfinished destination as installed or delete the old release.

## Save discovery and reuse

See engine-save-research.md. Detect engine fingerprints and readable identity/configuration; scan recognized local save/preference paths and identity-specific external locations. Never execute game scripts or deserialize executable save payloads to discover a path.

Remember per-game rules with evidence, local paths, external paths/scopes, overrides, storage mode, and detection status. Local and external storage may both be active. Scan again after gameplay and before updates. Reuse the plan when the staged release retains its engine, save identity, storage mode, and relevant layout. Re-detect on changes; ask only about unresolved choices.

For a supported layout allowing external saves, a complete readable scan finding no local saves proceeds using the expected external rules without prompting. An external folder need not exist before first play. Check local preferences independently. Unreadable folders do not count as empty. Record expected-external/no-local-data rather than claiming an external save was observed.

Preserve registry/browser state and external files in place; do not export them into backups. Copy only explicitly identified local saves/preferences to the new release, without silently combining conflicting copies. All listed engines need adapters, with per-game overrides for custom behaviour.

## Reconciliation, retention, and deletion

Scan/Sync folder reconciles tracked installations with disk state; its transfer operation is restricted to saves/preferences during an update. It is not full-folder merging or cloud synchronization. A debounced watcher may assist local reconciliation while the app runs; events never launch, install, or delete games automatically.

Offer global **Old versions after update** choices with per-game overrides: Keep, Keep previous, or Delete old versions after successful update. Default to Keep until the user chooses. Permanent cleanup runs only after extraction and save transfer succeed. It removes the old release's game files, including its redundant local saves only after those have been copied successfully. External saves remain untouched.

Compressed-file cleanup is automatic after a confirmed installation/update, not an opt-in preference. Delete only the archive(s) belonging to that job, including confirmed multipart members where applicable. Retain archives for download-only, failed, cancelled, and unconfirmed installations. If a manual installation is explicitly registered as completed for a particular download job, it can complete this same cleanup step. Mark a cleaned-up downloads entry installed/archive removed, rather than leaving a broken Install action. Show installation/download sizes. No backup storage or backup-retention controls exist.

Provide Delete/uninstall beside games and individual versions, distinguishing **Remove from library** from **Delete game files**. Show the exact affected paths and size. Preserve saves/preferences by default: for an uninstall without a replacement, leave local save-bearing folders/data in place while removing known game payload; do not create a backup copy. Deleting the remaining saves/preferences requires an explicit additional choice. For mixed or unclassified imported layouts, do not recursively delete unknown content under a save-preserving action.

Do not delete the games root, other games, shared external directories, or paths reached outside the registered scope through traversal/symlinks/junctions. Respect active jobs, running games, and offline drives. Report partial failures clearly. Manual deletion may use Trash/Recycle Bin; make permanent cleanup explicit where selected to reclaim space.

## Closing and update-check activity

Closing the main window quits the application; there is no background tray process. If a download or app-managed update is active, show: **Closing the app will cancel the active download/update. Are you sure?** Offer Stay open and Close and cancel. With no active download/update, quit without a prompt; a metadata update scan alone does not require one.

Cancel app-owned downloads and installation work before shutdown, leaving the original installation intact. External extraction applications have an independent lifecycle; do not manage or wait for them to close. If extraction finishes after the app quits, its output remains unconfirmed until the user resumes the archive's Install/Update action. Preserve the completed archive and download context across restarts, then accept completion information or selection of the extracted folder before transferring saves/preferences and updating launch paths. Partially downloaded jobs remain cancelled/incomplete with retry/clear actions. No background extractor supervision is required.

Update checks run only while the app is open. Show a visible checking indicator and last successful check or failure; never imply checks continue after quit.

## Distribution, errors, and diagnostics

Use GitHub eventually for application source, releases, packages, and app updates. Keep the small bootstrap-installer direction: download the tested platform/architecture package, including required runtime/libraries, during setup. Windows may use nsis-web; macOS bootstrap packaging remains a platform-specific implementation task. Optional extraction helpers are not a substitute for the user's configured extraction program.

Give useful errors with the failed step and a retry/clear or locate action. Provide readable **.txt** diagnostics with Copy and Save actions so users can paste into a forum post or upload the file. Include app/OS/architecture, engine-rule version, game thread ID, job stage, timestamps, and relevant error details. Exclude passwords, cookies, auth headers, signed URL values, and unnecessary personal path information. No automatic diagnostic upload. Record actual test coverage and known alpha issues.

## Alpha validation

Exercise all in-scope engine adapters; prioritize Ren'Py local/external save and preference carry-forward. Test on the user's Windows and macOS ARM devices and record which additional target builds remain untested. Verify login, download attribution through actual exit pages, retries/clearing, normal and external ZIP extraction, Show in Explorer/Finder, manual patch/installer handling, launch, save/preferences-only update, retention/deletion, selected-root use, and .txt export.

Check cancellation/failed extraction and save transfer without altering the original; unreadable paths; full/offline disks; multiple threads and duplicate titles; and closing with/without active work. Verify that engine context exists before extraction, the output picker defaults to the chosen games directory, and extraction continuing after quit can be finalized from the retained archive without redownloading. Verify automatic archive cleanup only after confirmed installation, with cleanup failures retryable independently. Confirm there are no snapshot/restore features or whole-installation merges. Alpha bugs are expected and reportable; experimental adapters must remain identifiable in diagnostics.


Implementation clarification, 2026-11-08: starting an external extractor is a pending installation, not confirmation of success. Show an explicit output-folder handoff and use Finish installation / Finish update for pending jobs. Resume existing extracted output without extracting a second copy. Register the launch target and installation before marking the download installed and removing its archive. Check site is a one-page health probe. Initial update checks establish a first-page checkpoint and verify unknown/changed games; ordinary incremental scans stop at the previous frontier. Explicit full checks verify linked threads after sampling the first page, without crawling the entire listing. Preserve the date-window query on every page and report page/entry counts. Keep the working LC HTML/rendered adapter unless its actual JSON endpoint is verified.

User clarification, 2026-11-08: accepting Install in the download-completion prompt and using Install in the library must execute the same complete installation routine. Ordinary ZIPs use managed extraction, automatic platform/engine-aware launch detection, a fresh linked-thread/cover read, local version detection and comparison, save/preferences transfer, launcher registration and archive cleanup. Do not require routine output/launcher confirmation after accepting installation. A configured external extractor is for explicit external extraction and formats/features not supported by the built-in ZIP path. File versions take precedence over download/forum labels; show parity as unverified if local or fresh forum evidence is missing. Record mismatches and metadata-fetch failures without inventing success or unnecessarily blocking a valid local installation. Output selection is an exceptional recovery path for unsupported external extraction or genuinely unresolved launch detection.

Large-library update policy, clarified 2026-11-08: retain latest-listing discovery as the primary update path. Normal polls scan newer entries against a per-source saved frontier and verify only changed linked threads, plus a small overdue reconciliation batch. URL slugs can change while numeric thread identity remains stable; canonical same-ID redirects are supported. Never assume a requested seven-day filter constrains the response. An initial baseline uses page 1, not an exhaustive catalogue crawl. Missing frontiers or expired windows require one bounded catch-up and a new checkpoint after successful game verification; they must not enter a permanent 20-page failure/retry loop. Preserve checkpoints on real fetch/parser/version failures.

Alpha preparation, 2026-11-08: run local games-folder reconciliation on startup, preserving missing-game metadata and source links, distinguishing disconnected folders, discovering recognised extracted games and suppressing redundant archive suggestions for installed titles. Do not merge game identities by archive name. Failed/cancelled transfers clean their app-managed partial files and return the user to the forum thread for manual redownload. Delegate multipart/password handling to the chosen extractor. Ship the predefined named-engine rules as experimental; record reports rather than delaying alpha for every engine's live validation. Public source must exclude all runtime libraries/profiles/credentials and generated local output. GitHub builds target macOS ARM64, macOS Intel x64 and Windows Intel/AMD x64 (the user's clarification of x86).
