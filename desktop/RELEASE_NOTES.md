# Neo Desktop 0.1.29

Includes Web 0.1.26 and Core 0.2.50.

- Faster session management with cached transcript summaries, server-side search and real ten-session pagination. No eager session restoration.
- Sidebar quick switching with date groups, on-demand scrolling pagination, consistent pink loading rings and a half-second, uniform one-pixel selection frame.
- Session-title context menus offer protected, confirmed deletion. Desktop replaces the native WebView context menu while ordinary browser menus remain available on the Web.
- Context compaction displays its own animated status icon and streams the actual summary text into the observation panel without adding chat messages.
- Model, CPA, tools and plugins move into dedicated settings pages. Prompt settings are named "提示词"; the unused desktop sidebar prompt-management entry is hidden.
- User images appear as borderless thumbnails with click-to-preview. User file attachments show only their filename, without buttons or borders. Original text spacing is preserved without extra image-label gaps.
- Static outline hover for session-management rows and aligned launcher action icons.
- Expanded session pagination, switching, deletion, compaction streaming, attachment and responsive UI regression coverage.

The release workflow verifies published npm versions, tests Core/Web/Desktop, builds the Windows x64 installer, and verifies actual installation and upgrade before publishing artifacts.
