# Earmark changelog

Newest first. The version is shown in Settings > About.

## 0.18.2 (Nov 18, 2026) - preview branch `earmark-0.18.2-preview`

Fixes
- Logging: typed time can no longer take today past 24 hours. Typing 30 in the hours box (a slip for 30 minutes) used to log 30 hours at once and hand out several medals. Now the form stays open and says why. Timer time is unchanged.
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
