# Internal engine support priorities

Planning note, 2026-11-07. This is internal research, not a shipped reporting feature. No application changes or telemetry are required.

## User-provided catalogue counts

On 2026-11-07 the user supplied the following F95 engine-filter page totals, reporting 30 games per page. Multiplying pages by 30 gives the estimates below. The research tools did not independently inspect the forum. No recent-update date restriction was reported, so this is catalogue composition, not a 90-day activity measurement or userbase measurement.

| Engine filter | Pages | Estimated games | Share of listed total |
| --- | ---: | ---: | ---: |
| Ren'Py | 353 | 10,590 | 37.3% |
| Unity | 168 | 5,040 | 17.8% |
| RPGM / RPG Maker | 165 | 4,950 | 17.4% |
| Others | 148 | 4,440 | 15.6% |
| HTML | 49 | 1,470 | 5.2% |
| Unreal Engine | 26 | 780 | 2.7% |
| Godot | 17 | 510 | 1.8% |
| Flash | 11 | 330 | 1.2% |
| WOLF RPG | 5 | 150 | 0.5% |
| QSP | 3 | 90 | 0.3% |
| Java | 1 | 30 | 0.1% |
| **Listed total** | **946** | **28,380** | **100%** |

Shares use the 946 supplied pages as their denominator; rounding can prevent displayed shares summing to 100%. Estimates assume engine filters do not overlap. The user omitted five other engines because each had fewer than a page of games and/or its last update was over two years ago; their counts and identities are not available and are excluded. If terminal pages are not full, page-derived game totals will be slightly high. Do not claim engines currently on our model list are present in the catalogue unless the supplied evidence identifies them.

## What to count

- Prefer unique game threads updated during the last 90 days, if the site's filters expose both engine and update period. Record the exact period, collection date, filters and total.
- If only all-time filter totals are available, label them as catalogue composition. They include inactive games and do not establish current activity.
- A bounded sample of the latest unique threads is another possible input, but must be labelled a sample. Even after deduplication, frequently updated games are more likely to appear in such a sample.
- Count each thread once. Keep unknown engines visible in the denominator. Numeric prefix IDs alone are not engine names.
- Keep RPG Maker editions separate when identifiable, with an additional family total; a generic RPGM tag does not establish MV, MZ or an older edition.
- Group Unity/Naninovel and HTML/Twine at family level without double counting, retaining subtypes for save-handling decisions.
- Forum catalogue share measures games, not actual users, downloads or installed-library share. We have no userbase measurement.

## Recommended allocation

| Group | Current decision | Evidence needed next |
| --- | --- | --- |
| Ren'Py | First assisted-update validation target | Real install, save, update and load cycles on Windows and macOS ARM |
| RPG Maker editions | Core assisted-update target; start with MV/MZ layouts | The generic RPGM filter does not establish the edition split; identify each installed layout |
| Unity / Naninovel | Core assisted-update target after Ren'Py | Identify the actual runtime/subtype and stable game identity across releases; Naninovel was not counted separately |
| HTML / Twine | Next extension after the core three | Distinguish story format/wrapper and preserve browser storage identity; do not assume every HTML game is Twine |
| Unreal Engine and Godot | Later extension after the core workflows pass | Representative game testing and stable identity; relative implementation effort can change the order |
| Flash, WOLF RPG, QSP and Java | Recommend manual installation/update for the first alpha | Their combined share is about 2.1% of the supplied catalogue; keep metadata, downloads and registered launches available |
| Five omitted engine categories | Defer assisted-update work | Names/counts are unknown; the user reports small catalogues and/or no updates in over two years |
| Others / unknown | **Always manual for unknown engines, as explicitly requested** | Never apply a generic automated save-transfer rule based on an unknown engine |

Ren'Py + Unity + RPG Maker represent **72.5% of the supplied catalogue**, or **86.0% after excluding Others**. Adding HTML raises coverage to **77.7% overall**, or **92.1% of the known-engine portion**. Adding Unreal and Godot raises it to **82.2% overall**, or **97.5% of the known-engine portion**. These figures are potential catalogue coverage, not current validated application support.

This recommends replacing the earlier all-engine assisted-update alpha target with a measured priority order. The user has explicitly excluded Others from assisted support; the other tier boundaries are recommendations. No runtime policy, installer gate, engine selector or app UI has been changed by this research note. In particular, enforcing the unknown-engine exclusion in the installation flow remains implementation work; do not describe it as already enforced.

## Popularity and update complexity are separate

A low-frequency engine may still be inexpensive to support. For example, Godot documents external `user://` storage with configurable project-specific directories; an update retaining the same resolved identity may need no local save transfer. Conversely, a common engine's customised or unidentified layout can still need manual handling. See [Godot's data-path documentation](https://docs.godotengine.org/en/stable/tutorials/io/data_paths.html).

Ren'Py update handling is deliberately simple, as clarified by the user on 2026-11-08: copy all existing local save-folder files into the new release's corresponding save folder; if the old folder is absent or empty, proceed without a local transfer and leave external data untouched. External-save discovery, identity comparison and local/external reconciliation are not prerequisites or extra confirmation steps. See the agreed rule in [engine save research](engine-save-research.md).

Manual handling still includes the library entry, forum metadata/update notification, user-initiated download, reveal-in-Finder/Explorer and a registered launch target. The scoped feature is extraction/save transfer/installation confirmation, not unattended provider downloads. Only identified saves and preferences transfer; old program files never merge into the new release.
