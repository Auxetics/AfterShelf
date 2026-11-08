# Engine save research and proposed rules

Scope update, 2026-11-07: retain the research below, but use [internal engine priorities](engine-priorities.md) for the latest usage-based proposal. The user explicitly excludes Others/unknown engines from assisted updates. Earlier references to every listed family being an alpha target do not override that decision; the remaining recommended tier boundaries have not yet been adopted or enforced in code.

Researched 2026-11-06. All listed engine families are alpha targets, with Ren'Py highest priority. Windows/macOS x64 and ARM64 are the current targets; Linux paths below are research context only. These are documented or source-inspected defaults, not completed or tested application support. Developers, plugins, engine versions, and packaging can override them. Resolve identities from game metadata or user selection rather than guessing from forum titles. Never execute downloaded game scripts to discover a path.

## Discovery and reuse

Use these engine defaults to scan each registered game installation and a bounded set of identity-specific external locations. A scan can find evidence of local, external, or mixed storage. Registry and browser state require their own discovery adapters.

For a supported engine/layout that permits external saves, a complete readable scan finding no local save data should proceed with the expected external-storage plan without asking the user to confirm a save location. There is nothing identified locally to carry forward; the game may not have saved yet. Preserve the external location in place if it exists, but its absence does not block installation. Do not create a backup or snapshot. Record this as expected-external/no-local-data rather than falsely asserting an external save was found. Scan local preferences independently and transfer them if identified. Access failures or unsupported custom layouts remain unresolved, not empty.

Persist the discovered preservation plan per game, including evidence, identity, relative local paths, resolved external paths/scopes, overrides, and confidence. Re-scan after gameplay and before updating. Compare readable identity/storage metadata in a staged release, then reuse the plan when compatible. An engine/layout/identity change or conflicting evidence triggers re-detection; ask only about unresolved choices. Do not promise detection of arbitrary custom save code from static scanning alone. Reconciliation transfers only explicitly identified saves and game preferences; it never merges an old installation folder into the new release.

Update cleanup removes the old installation only after local saves/preferences have been copied successfully into the new release. On uninstall without a replacement, leave local save/preferences data in place and remove known program files, unless the user explicitly chooses to delete that data. External save data remains by default. There is no backup/restore feature. See [application-spec.md](application-spec.md) for games-root selection, reconciliation, version retention, and deletion requirements.

## Ren'Py

Source inspection shows a user save directory plus a game-local `game/saves` location on non-mobile builds that are not macOS app bundles. User locations normally resolve to `%APPDATA%/RenPy/<save_directory>` on Windows, `~/Library/RenPy/<save_directory>` on macOS, and `~/.renpy/<save_directory>` on Linux. The configured identity is `config.save_directory`; custom paths are possible.

Agreed update rule (clarified by the user, 2026-11-08): inspect the old installation's local saves folder and copy all files in it, including persistent data and nested files, into the corresponding folder of the extracted new release. If that folder is missing or empty, proceed with no local save transfer: the user has not saved locally, or saves are external and remain in place. Do not require an external-save search, save-identity comparison, local/external reconciliation or additional save-location confirmation before completing a Ren'Py update. The existing save inspection UI may display external locations, but those locations are not an update prerequisite. Transfer only saves/preferences, not the old program files.

Sources: [save locations](https://github.com/renpy/renpy/blob/master/renpy/savelocation.py), [save configuration](https://www.renpy.org/doc/html/config.html#var-config.save_directory).

## RPG Maker MV

The core implementation chooses a `save/` directory relative to the runtime entry point, with a fallback one level above if the normal location is unwritable. Packaged layouts commonly yield `www/save` or `save`; neither is universal. Slot files use `.rpgsave`, with separate global/config files and backup files. Browser mode uses web storage instead of desktop files.

Agreed rule (2026-11-08): copy all files in existing local `save/` or `www/save/` directories, including slots, global/configuration data and any files already kept there by the game. The scanner also locates packaged content by `js/rpg_core.js` so save directories inside a macOS bundle are included. Missing or empty local directories mean there is nothing to transfer; proceed without save-location prompts or external-save discovery. Existing external/browser storage stays in place. User-selected local overrides remain available for custom locations, but are not a prerequisite to the default flow. Copy only the save set, never the old program files.

Source: [MV StorageManager implementation](https://github.com/rpgtkoolmv/corescript/blob/master/js/rpg_managers/StorageManager.js).

## RPG Maker MZ

A published runtime source copy (v1.1.0) resolves desktop saves to `save/` beside the runtime entry point and names them `<saveName>.rmmzsave`. Browser mode uses localForage with a game-specific key. This is evidence for that runtime version, not verification of every current MZ build.

Agreed rule (2026-11-08): apply the same local-files-or-no-transfer flow as MV, using `save/` and `www/save/` plus packaged content located by `js/rmmz_core.js`. Copy the whole existing save set, including global/configuration data. Missing or empty local saves do not block an update or require a location confirmation. External/browser storage is left in place. Standard local transfer layouts have synthetic fixture coverage; live-game and browser-profile behaviour remain unverified.

Source: [inspected MZ runtime source copy](https://github.com/stak/rmmz-corescript/blob/master/rmmz_managers.js). Validate against a distributed game before enabling assisted updates.

## Unity

The documented Windows player path is usually `%USERPROFILE%/AppData/LocalLow/<company>/<product>`. Unity 2022.3 documents macOS player storage under `~/Library/Application Support/unity.<company>.<product>`, with an existing alternate company/product directory taking precedence. Linux uses `$XDG_CONFIG_HOME/unity3d/<company>/<product>`, defaulting to `~/.config`. Version-specific macOS legacy paths need discovery.

PlayerPrefs is separate: Windows uses a per-company/product registry key; macOS uses a bundle-identified preferences plist; Linux uses the Unity configuration area. Games can store progression there or use custom files.

Proposed rule: confirm company, product, bundle identity, and actual save files. Preserve external files and registry/preferences state in place. Copy only identified installation-local saves/preferences into a new release. No registry export or snapshots are required. Never delete a company-level key shared by other games.

Sources: [persistentDataPath, Unity 2022.3](https://docs.unity3d.com/2022.3/Documentation/ScriptReference/Application-persistentDataPath.html), [PlayerPrefs](https://docs.unity.com/en-us/engine/6000.0/script-reference/unityengine/playerprefs).

### Naninovel (Unity subtype)

Naninovel separates game state, global state, and settings, supports custom serialization, and uses Unity persistent storage. Its v1.21 guide places settings outside the Saves folder, while another official documentation deployment describes newer layouts with settings inside Saves. Treat layout as version/configuration dependent.

Proposed rule: refine the Unity profile using the actual Naninovel version and configured paths; include global unlock/read state and settings as well as slots. Do not assume a folder named Saves contains all game preferences or persistent state.

Sources: [v1.21 state management](https://naninovel.com/guide/state-management), [alternate official documentation deployment](https://naninovel.netlify.app/guide/state-management).

## Godot

Default `user://` directories are `%APPDATA%/Godot/app_userdata/<project>` on Windows, `~/Library/Application Support/Godot/app_userdata/<project>` on macOS, and `~/.local/share/godot/app_userdata/<project>` on Linux. Custom user directories can move storage to the platform application-data root and change its name. Linux XDG overrides matter. Web exports use IndexedDB.

Proposed rule: resolve project name and custom-user-directory settings where readable; confirm the exact game directory. Leave it in place when replacing game files; do not create a snapshot. A `.pck` alone does not establish the save identity.

Source: [Godot data paths](https://docs.godotengine.org/en/stable/tutorials/io/data_paths.html).

## GameMaker

The documented sandbox save area is `%LOCALAPPDATA%/<game name>` on Windows, normally `~/Library/Application Support/<game name>` on macOS (sandboxing can alter it), and `~/.config/<game name>` on Ubuntu. HTML5 uses browser storage. Desktop games can disable the file sandbox and use other locations.

Proposed rule: confirm runtime game identity and sandbox behaviour. Preserve external data; use a game-specific override when the developer chose another path. Do not mistake GameMaker editor configuration for a game's saves.

Source: [GameMaker filesystem and save areas](https://manual.gamemaker.io/lts/en/Additional_Information/The_File_System.htm).

## Unreal Engine

Epic documents its SaveGame API and `.sav` files in `Saved/SaveGames` for development platforms. This does not establish one installation-relative save path for all shipped games, operating systems, or packaging modes.

Proposed rule: discover and confirm the actual game's Saved/SaveGames location and any additional progression/settings data. Preserve an external location in place; copy an identified installation-local location into staging. Do not copy the entire Saved tree blindly: it can contain caches and logs. Default to manual confirmation until shipped-build profiles have been tested.

Source: [Epic saving/loading documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/saving-and-loading-your-game-in-unreal-engine).

## HTML / Twine / SugarCube

SugarCube supports browser saves and disk exports. Save identity includes the configured story identity; browser profile/origin continuity also matters. SugarCube 2.37+ provides a saves-bundle export/import API; old games need version-aware handling. Twine is not itself one save format: Harlowe and custom formats need separate adapters.

Proposed rule: launch managed HTML games through a stable, game-specific origin and persistent profile. Keep that profile outside version folders. Offer supported disk export/import; preserve storage in place with the game closed. Replacing an HTML file is insufficient evidence that saves will survive. External-browser saves need export/import or a separately confirmed profile; do not assume access to them.

Source: [SugarCube save APIs](https://www.motoslave.net/sugarcube/2/docs/#save-api).

## TyranoScript / TyranoBuilder

The upstream implementation supports web storage, compressed web storage, and file storage. Its inspected file mode writes keyed `.sav` files near the executable; a macOS temporary-path case uses `~/_TyranoGameData`. The project ID is configured in `data/system/Config.tjs`. Wrappers and versions can change this behaviour.

Proposed rule: resolve project identity and storage mode from readable configuration. Copy only identified game-keyed local saves; preserve confirmed external files or browser storage. Never copy every `.sav` file from a shared directory based solely on engine type.

Sources: [upstream storage implementation](https://github.com/ShikemokuMK/tyranoscript/blob/master/tyrano/libs.js), [project configuration](https://tyranoscript.com/usage/tech/custom).

## Older RPG Maker defaults and remaining research

Older RPG Maker rules now have synthetic save-transfer coverage for their existing edition-specific root-file patterns: XP `Save*.rxdata`, VX `Save*.rvdata`, VX Ace `Save*.rvdata2`, and 2000/2003 `Save*.lsd`, with numeric slot names. XP/VX/VX Ace also check existing `Save`/`save` folders. Missing or empty local save locations proceed with zero transferred files. These profiles do not copy `Game.ini` or old game databases. No game or save script is executed to discover files, and real-game validation remains outstanding.

WOLF RPG, KiriKiri, Harlowe/other HTML formats and custom layouts have remaining research gaps. Use the scope update at the top of this document and the current internal priorities rather than the historical all-engine alpha target.

## Suggested implementation order

1. Ren'Py and native RPG Maker MV, then validated MZ layouts: identifiable game-local data and clear full-release handling.
2. Unity/Naninovel, Godot, and GameMaker: metadata-based external-directory discovery and preferences preservation in place.
3. SugarCube/HTML and Tyrano: browser identities, wrapper-specific modes, and supported export adapters.
4. Unreal, older RPG Maker, WOLF, KiriKiri, other Twine formats, and custom overrides. All remain alpha targets; sequence research and implementation rather than excluding them.

For every profile, validate new install without saves, normal update with saves and unlocks, custom paths, conflicting sources, changed identity, missing files, failed extraction/save transfer with the original retained, sequential cleanup, and manually selected launch targets. No backup/restore or general rollback subsystem is planned. No profile in this document has yet passed those game-based checks.

## Installed release metadata

Ren'Py documents config.name and config.version as the game's name and release, distinct from its runtime/script compatibility version. The local reader accepts literal configuration strings without executing Python or reading compiled scripts/save payloads. In macOS distributions, upstream Ren'Py writes build.version into CFBundleShortVersionString and a timestamp into CFBundleVersion. The reader uses the former as fallback release evidence and ignores the timestamp. build.version defaults to config.version but can differ, so preserve the raw label and show its provenance rather than inventing version punctuation. Unknown versions and manual overrides remain supported.

Sources: [Ren'Py project information](https://www.renpy.org/doc/html/config.html#project-info), [build.version](https://www.renpy.org/doc/html/build.html#var-build.version), [upstream macOS plist writer](https://github.com/renpy/renpy/blob/master/launcher/game/distribute.rpy).
