# Neo Desktop 0.1.27

Includes Web 0.1.25 and Core 0.2.49.

- Redesigned dark spotlight launcher with a two-second entry transition and stable package-level download progress.
- Persistent user attachment and image previews with actual-format validation; malformed images no longer break a session. No new attachment size limit.
- Compact attachment cards with always-visible file sizes. Desktop folder icons reveal the original file in Explorer; browser downloads remain unchanged.
- Pasted text retains line breaks, blank lines and indentation after sending and reloading.
- Compact single-row model ID and usage indicators.
- Square, text-free execution indicator driven by waiting age and actual tool calls. Clock stays left; paused runs offer a play button; completed runs show only the soft-green clock and duration.
- Tool observation panels hide smoothly after five unchanged seconds at the bottom and return on new content.
- Animated right-angle tool connections track layout changes without duplicate or disconnected segments.
- Expanded image, attachment, desktop, accessibility and browser regression coverage.

The release workflow verifies published npm versions, tests Core/Web/Desktop, builds the Windows x64 installer, and verifies actual installation and upgrade before publishing artifacts.
