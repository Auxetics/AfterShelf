# AfterShelf branding

Approved application name: **AfterShelf**, 2026-11-08. Interface descriptor: **Your games, kept current.**

The mark combines a crescent moon with three game-case/book spines on a shelf. Mint and ivory work with the existing midnight interface. The mark has no site-specific initials or adult imagery and remains usable at small icon sizes.

## Assets

- [Generated PNG master](../app/assets/aftershelf-master.png), with transparency retained.
- [1024-pixel app icon](../app/assets/aftershelf-1024.png); additional PNG sizes: 16, 32, 48, 64, 128, 256 and 512 pixels.
- [Windows multi-resolution icon](../app/assets/aftershelf.ico).
- [macOS icon](../app/assets/aftershelf.icns).

The sidebar, settings button, HTML title/favicon, native window/menu, diagnostics and package metadata use AfterShelf. macOS development runs explicitly set the Dock image; release builds reference ICNS/ICO assets in electron-builder. `npm run icons` rebuilds the exports on macOS using sips/iconutil. Prebuilt outputs are included for Windows builds; no image-conversion runtime dependency is shipped.

Existing LC Library profiles are reused in place, including Chromium session storage. Fresh installs use the AfterShelf data directory. `AFTERSHELF_DATA` is the preferred isolated-profile override; `LC_LIBRARY_DATA` remains compatible. The repository folder is not renamed.

## Generation provenance

Tool: built-in `image_gen.imagegen`, transparent background enabled. The generated PNG was copied into the workspace, then resized/exported with macOS image utilities. No API key or CLI image-generation fallback was used.

Final generation prompt:

> Use case: logo-brand. Asset type: production app icon for AfterShelf, a desktop game library and game update tracker. Create one polished standalone square icon, not a presentation or contact sheet. Subject: a bold, original shelf emblem made from three simple upright game-case/book spines on one short horizontal shelf, integrated with a clean crescent moon to suggest an after-hours collection. Resolve the shapes into a single memorable, balanced symbol with generous negative space, legible at 24–32 pixels. Style: precise flat vector-like geometry, softly rounded corners, restrained modern desktop software identity. Use the app's existing mint green (#58cab0), warm ivory (#e9ecf2), and deep midnight navy (#151d29). Put the mint/ivory symbol on a midnight rounded-square tile, centered, with about 8% transparent outer padding suitable for a macOS Dock icon. Background outside the tile must be truly transparent. No lettering, initials, words, tiny details, decorative stars, photorealism, heavy shadows, gradients, extra badges, or mockup. Render clean crisp contours at 1024 x 1024.

The image model supplied subtle shading despite the flat-style instruction; the retained output was visually inspected and the app renderer successfully decoded its 64-pixel icon. No trademark/domain clearance is claimed by this implementation.
