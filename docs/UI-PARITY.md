# Telegram Web parity ledger

Textor's conversation is benchmarked against Telegram's two open-source web clients:
[Web A/Z](https://github.com/TelegramOrg/Telegram-web-z) (a fork of `telegram-tt`) and
[Web K](https://github.com/TelegramOrg/Telegram-web-k) (a fork of `tweb`). Both are
GPL-3.0; Textor is AGPL-3.0. Their behaviour and measurements were studied and
reimplemented here in Textor's own modules — no code was copied, and no dependency came
with them.

Each row is one pattern: what Telegram does, where Textor does it, and its state. The
decisions behind them are ADR-060 and ADR-061 in [`DECISIONS.md`](DECISIONS.md).

## The conversation

| Pattern                                                      | Telegram                                       | Textor                                                                                                          | State                                         |
| ------------------------------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| One chronological column, sent at the end, received at start | Both clients                                   | `.message-stream` in `ChatView.tsx`; logical alignment, mirrored in Persian                                     | Done (ADR-060)                                |
| Order by the author's time, the same on every device         | Server message ids                             | A causal clock per conversation, carried in each rumor; each bubble shows its author's own time (`timeline.ts`) | Done (ADR-063)                                |
| A reading-width column in the middle of a wide window        | Web A: 47.5rem                                 | `--chat-max`, 46rem; the composer shares its gutter                                                             | Done (ADR-060)                                |
| The list beside the conversation on a wide window            | Both clients                                   | `Panes` in `App.tsx`, from 60rem                                                                                | Done (ADR-060)                                |
| Runs of bubbles: 15 px corners, 6 px where two meet          | Web A: `--border-radius-messages`, `-small`    | `--radius-bubble`, `--radius-bubble-joined`; `group-start`, `group-end` rows                                    | Done (ADR-061)                                |
| A tail on the last bubble of a run                           | Web A: a 9 × 20 SVG appendix                   | A 9 × 17 CSS mask in the bubble's own fill, turned for side and direction                                       | Done (ADR-061)                                |
| One tick sent, two read                                      | Both clients                                   | `StatusIcon` in `MessageBubble.tsx`; delivered is one tick                                                      | Done (ADR-061)                                |
| When it was read                                             | Web A: "read at" in the menu of a private chat | Details sheet: sent, delivered, read; each member in a group                                                    | Done (ADR-061)                                |
| History loads as the reader scrolls back                     | Both clients                                   | An `IntersectionObserver` at the top, holding the reader's place; the button stays for a keyboard               | Done (ADR-061)                                |
| The way back to the newest message                           | Both clients, with an unread count             | `.jump-latest`, shown a screen or more above the end                                                            | Done; the count is not shown yet              |
| A windowed timeline                                          | Both drop rows far from view                   | The window grows as one scrolls back, 60 at a time                                                              | Not done: see ADR-061, "Not done"             |
| Sticky date                                                  | Both clients                                   | Dates are rows in the stream                                                                                    | Not done: stacked sticky pills need measuring |
| Pictures edge to edge, time over the picture                 | Both clients                                   | Pictures fill the bubble's width, caption below                                                                 | Not done: every attachment carries a caption  |
| Swipe to reply                                               | Mobile apps and Web K on touch                 | Reply from the menu or the button beside the bubble                                                             | Not done                                      |

## Locations

| Pattern                                              | Telegram                                         | Textor                                                                                    | State                        |
| ---------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------- |
| Send where you are, or a place                       | Attach menu: Location                            | `LocationPicker`: your position, tap the map to move the pin, or paste coordinates/a link | Done (ADR-064)               |
| Live location for 15 min, 1 h, 8 h, or until stopped | Both clients and the mobile apps                 | The same four choices                                                                     | Done (ADR-064)               |
| A map in the bubble                                  | Tiles from Telegram's servers                    | Drawn on the device from the positions: grid, scale, north, halo, heading, path           | Done, deliberately different |
| A pulse while live, a ring counting down             | Mobile apps; Web A                               | `LocationCard`: pulse while heard from, a ring, "updated 2 min ago · 13 min left"         | Done (ADR-064)               |
| Stop sharing, from the bubble and a bar              | The bar above the chat list and the conversation | `LiveBanner` in both places, and Stop in the bubble and its sheet                         | Done (ADR-064)               |
| Details: distance from you, heading, speed           | Mobile apps                                      | The sheet; your position only when asked, never sent                                      | Done (ADR-064)               |
| Search for a place, and street names                 | Foursquare and map services                      | None: a search would tell a map service what was looked for                               | Not done, deliberately       |
| Keeps sharing in the background                      | The mobile apps                                  | Only while Textor is open; readers see how old the newest position is                     | A web app's limit            |

## Acting on messages

| Pattern                                          | Telegram                                                         | Textor                                                                              | State                        |
| ------------------------------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- |
| Menu: reactions first, then the actions          | Web A context menu                                               | Reactions, then Reply, Copy, Forward, Select, Details, Delete                       | Done (ADR-061)               |
| Touch: tap for the menu, hold to select          | Android; Web K on touch                                          | `usePress` in `hold.ts`; a right click opens the menu too                           | Done (ADR-061)               |
| Selecting: a check per row, a bar with count     | Android: the header; Web A and K: a bar in place of the composer | The header becomes the bar — count, Forward, Delete; Escape ends it                 | Done (ADR-061)               |
| Delete asks how                                  | Web A: "Also delete for {name}", ticked; mobile: two answers     | "Delete for me and {name}" or "Delete for me", as two answers; Cancel has the focus | Done (ADR-061)               |
| Either person deletes anything in a private chat | Private chats                                                    | A `redact` from the other person in a direct conversation is honoured for any entry | Done (ADR-061)               |
| In a group, only one's own for everyone          | Groups without admin rights                                      | The same                                                                            | Done                         |
| Forward                                          | Names the original author                                        | A copy naming nobody; attachments sent afresh                                       | Done, deliberately different |
| The app's own dialogs, never the browser's       | Both clients                                                     | `dialog.tsx`: `ask`, `confirmDanger`, one host in the shell                         | Done (ADR-061)               |
