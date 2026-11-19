# Earmark changelog

Newest first. The version is shown in Settings > About.

## 0.19.0 (Nov 18, 2026) - preview branch `earmark-0.19.0-preview`

New: Streak reminders (Settings > Notifications). The "Coming soon" row is gone.
- A switch and a time ("Remind me at", 8:00 PM unless you change it). Off until you turn it on.
- One reminder a day at that time on your phone's clock, and only if today doesn't count toward your streak yet. It names the streak: "Keep your 12-day streak going. Nothing logged yet today. 5 minutes keeps it alive." If you've logged a little but not enough it says how close you are ("You've logged 2 minutes today. 3 more and today counts."), if a rest day is saved it says so, and with no streak it reads "Start a new streak today".
- Turning it on first explains what it does in Earmark's own box, then your device asks about notifications. Not now leaves it off and the device is never asked.
- Notifications blocked, or a browser that has none: the switch still works. The note under it says how to allow them, and the reminder shows as a card at the top of Home (with a Log button) when you open Earmark after your time. On iPhone in Safari the note says to add Earmark to the Home Screen first.
- Where the reminder comes from: while Earmark is open, a card on Home. While it is in the background, a notification. When it is fully closed, a notification only where the phone lets Earmark wake up by itself (installed on Android or desktop Chrome); everywhere else, iPhone included, the card is waiting on Home the next time you open it.
- "Send a test reminder" shows one right away so you can see what it looks like.
- Turned on, or the time moved, after tonight's time has already passed: nothing pops up tonight; it starts with the next time.
- Tapping the notification opens Earmark. The X on the card puts it away for the day.
- The switch and time are kept on this device only (notification permission is per device). Nothing new is stored on the server or synced. Sign out and Reset all data forget them.

Limits to know
- A notification at the exact minute with the app fully closed, on every phone, needs server-sent push. That is not in this version.
- A closed app is only told about listening logged on this device. If you logged on another device, a closed Android app can still remind you; opening Earmark corrects it.
- A closed app keeps reminding for 7 days after it was last opened, then waits until you open it again.

Checks: `node tests/reminders.test.js` (the reminder rules, in six timezones including daylight-saving days).

Not changed: no database or sync changes, and the beta end date (still Nov 13, 2026).

## 0.18.3 (Nov 18, 2026) - preview branch `earmark-0.18.3-preview`

Fixes
- Timer: timer time now follows the same rule as typed time, a day holds 24 hours. If a timer's time doesn't fit beside what is already logged on a day, Earmark keeps what fits and a box says how much was left off and for which day ("Logged 10h of your timer. 1h 30m was left off..."). If nothing fits, the form stays open and the timer's time is still there to change or discard. Typing more than the timer ran (30 in the hours box) is stopped the same way as typed time.
- Timer: a second timer can no longer replace time that isn't logged yet. Stopping a timer, closing the form, then starting and stopping another used to drop the first one's time without a word. Now the form shows "1h from your timer isn't logged yet" with a Log it button until it is logged or discarded.
- Timer: after you stop a timer the form says "Timer stopped at 40m" instead of offering to start a timer again.
- Genre: books picked from search already arrive with their genre from the book database (checked, and the old to-do note in the code is gone). A book with no genre now reads "No genre" in Edit book, and a genre this version doesn't know no longer shows as a blank box.
- Quick start from Audible: minutes over 59 carry into the hours (100 hrs 75 mins adds 101h 15m) instead of being cut to 59. Same on the first-run setup page.

Checked, nothing to change: the app has no browser alert, confirm or prompt boxes left; every question already uses Earmark's own box.

Not changed: no database or sync changes, no new settings, the beta end date (still Nov 13, 2026).

## 0.18.2 (Nov 18, 2026) - preview branch `earmark-0.18.2-preview`

Fixes
- Logging: typed time can no longer take today past 24 hours. Typing 30 in the hours box (a slip for 30 minutes) used to log 30 hours at once and hand out several medals. Now the form stays open and says why. Timer time is unchanged (0.18.3 gives the timer the same limit).
- Logging: the button adds hours and minutes up, so 1 hour and 90 minutes reads "Log 2h 30m" instead of "Log 1h 90m".
- Stats: averages start on the first day you listened. A listener three days in used to see "Daily average 10m over 14 days" and "Weekly average 11m over 12 weeks"; now it is "45m over 3 days" and "2h 15m over 1 week".
- Stats: the Trend tile no longer compares with time before you started ("2h 15m more than the 12 months before", "more this year than 2025"). It shows "No earlier listening to compare yet" until there is an earlier period with listening in it.
- Books: a finish date can't be in the future (Edit book, Add a book and the + sheet). The date field's limit isn't enforced everywhere (typed dates, some phone pickers), and a book saved with a 2027 date dropped out of the Bookshelf's "Year" view.
- Books: minutes over 59 in a book's length carry into the hours (8 h 75 min saves as 9h 15m) instead of being cut to 59.

Not changed: no database or sync changes, no new settings, the beta end date (still Nov 13, 2026).

## 0.18.1 (Nov 18, 2026)

- A new day shows up without reopening the app; yesterday's "Logged today" notes clear, and a note logged just after midnight stays.
- "See all" on Home opens the Bookshelf on the books it names and clears a shelf search.
- Add a book's finish date allows today after midnight.
- The welcome page reads correctly after the planned beta end date.

## 0.18.0

- Stricter duplicate checks, Bookshelf search, a shorter Home, Find cover lists every edition.
