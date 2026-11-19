/* Streak reminders: checks for the scheduling rules (the RM block in index.html) and the service worker's
   matching rule (remPick in sw.js). No dependencies:  node tests/reminders.test.js
   The whole set runs once in each of several timezones, including ones with daylight saving. */
const fs = require("fs"), path = require("path"), { spawnSync } = require("child_process");
const ZONES = ["America/Denver", "UTC", "Asia/Kolkata", "Pacific/Auckland", "America/St_Johns", "Pacific/Kiritimati"];
if (!process.env.EARMARK_TZ_RUN) {
  let bad = 0;
  for (const tz of ZONES) {
    const r = spawnSync(process.execPath, [__filename], { env: { ...process.env, TZ: tz, EARMARK_TZ_RUN: "1" }, encoding: "utf8" });
    process.stdout.write(`${tz}: ${r.stdout.trim().split("\n").pop()}\n`);
    if (r.status !== 0) { bad++; process.stdout.write(r.stdout + r.stderr); }
  }
  console.log(bad ? `FAILED in ${bad} timezone(s)` : `All reminder checks pass in ${ZONES.length} timezones`);
  process.exit(bad ? 1 : 0);
}

const root = path.join(__dirname, "..");
const cut = (file, a, b) => { const s = fs.readFileSync(path.join(root, file), "utf8"), i = s.indexOf(a), j = s.indexOf(b); if (i < 0 || j < i) throw new Error(`markers not found in ${file}`); return s.slice(i, j + b.length); };
const RM = new Function(cut("index.html", "/* REMINDERS-PURE:START", "/* REMINDERS-PURE:END */") + "\nreturn RM;")();
const remPick = new Function(cut("sw.js", "/* REMINDER-PICK:START", "/* REMINDER-PICK:END */") + "\nreturn remPick;")();

let pass = 0, fail = 0;
const ok = (c, msg, got) => { if (c) pass++; else { fail++; console.log("FAIL  " + msg + (got !== undefined ? "   [" + JSON.stringify(got) + "]" : "")); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), msg, { got: a, want: b });
const at = (day, h = 0, mi = 0) => { const [y, m, d] = day.split("-").map(Number); return new Date(y, m - 1, d, h, mi, 0, 0); };
const T = "2026-11-18";                                   // "today" in most checks
const back = (n, from = T) => RM.addDays(from, -n);
const run = (len, endDaysAgo = 1, from = T) => Array.from({ length: len }, (_, i) => back(endDaysAgo + i, from));   // len days in a row, ending endDaysAgo days ago
const ON = { on: true, time: "20:00" };

/* times of day */
eq(RM.normTime("20:00"), "20:00", "20:00 stays");
eq(RM.normTime("8:05"), "08:05", "8:05 is padded");
eq(RM.normTime("07:30:00"), "07:30", "seconds are dropped");
eq(RM.normTime("23:59"), "23:59", "the last minute of the day is allowed");
for (const v of ["24:00", "25:10", "12:60", "", null, undefined, "abc", "8pm", {}, 20]) eq(RM.normTime(v), "20:00", `not a time inside a 24-hour day -> 8:00 PM (${JSON.stringify(v)})`);
eq(RM.timeLabel("20:00"), "8:00 PM", "label 8:00 PM"); eq(RM.timeLabel("00:05"), "12:05 AM", "label 12:05 AM");
eq(RM.timeLabel("12:00"), "12:00 PM", "label noon"); eq(RM.timeLabel("09:30"), "9:30 AM", "label 9:30 AM");
eq(RM.normPrefs(null), { on: false, time: "20:00", lastDay: null, hideDay: null, since: 0 }, "nothing saved: off, 8:00 PM");
eq(RM.normPrefs({ on: "yes", time: "99:99", lastDay: "today", hideDay: 5, since: "x" }), { on: false, time: "20:00", lastDay: null, hideDay: null, since: 0 }, "bad saved values are dropped");

/* the user's timezone: a reminder time is a wall-clock time on a local day, on every day of two years (daylight saving included) */
{ let wrong = [];
  for (let d = "2026-01-01"; d <= "2027-12-31"; d = RM.addDays(d, 1)) { const f = RM.fireAt(d, "20:00"); if (f.getHours() !== 20 || f.getMinutes() !== 0 || RM.key(f) !== d) wrong.push(d); }
  eq(wrong, [], "8:00 PM is 8:00 PM local on its own day, all of 2026 and 2027");
  wrong = [];
  for (let d = "2026-01-01"; d <= "2027-12-31"; d = RM.addDays(d, 1)) { const f = RM.fireAt(d, "02:30"); if (RM.key(f) !== d || isNaN(f)) wrong.push(d); }   // 2:30 AM doesn't exist on a spring-forward day: it lands later the same day
  eq(wrong, [], "a time skipped by daylight saving still lands on the same day");
  eq(RM.addDays("2026-03-07", 1), "2026-03-08", "next day across spring forward"); eq(RM.addDays("2026-11-01", 1), "2026-11-02", "next day across fall back");
  eq(RM.addDays("2026-12-31", 1), "2027-01-01", "next day across the year"); eq(RM.addDays("2028-03-01", -1), "2028-02-29", "leap day");
}

/* the streak on a day */
eq(RM.streakOn([], T, true), { streak: 0, restBank: 0 }, "no listening: no streak");
eq(RM.streakOn(run(12), T, false).streak, 12, "12 days through yesterday, nothing today: still a 12-day streak today");
eq(RM.streakOn([T, ...run(12)], T, false).streak, 13, "with today logged it is 13");
eq(RM.streakOn(run(12, 2), T, false).streak, 0, "missed yesterday, rest days off: the streak is over");
eq(RM.streakOn([T, ...run(12, 2)], T, false).streak, 1, "missed yesterday, logged today: day one");
eq(RM.streakOn(run(12), T, true), { streak: 12, restBank: 1 }, "rest days on: 12 days earns one rest day");
eq(RM.streakOn(run(12, 2), T, true), { streak: 12, restBank: 0 }, "rest days on: a missed yesterday uses the rest day and the streak carries on");
eq(RM.streakOn(run(6, 2), T, true), { streak: 0, restBank: 0 }, "rest days on, none saved: a missed yesterday ends it");
eq(RM.streakOn(run(12), RM.addDays(T, 1), false).streak, 0, "looking ahead: nothing logged today means no streak tomorrow (rest days off)");
eq(RM.streakOn(run(12), RM.addDays(T, 1), true), { streak: 12, restBank: 0 }, "looking ahead: the saved rest day covers today");
eq(RM.streakOn(run(12), RM.addDays(T, 2), true), { streak: 0, restBank: 0 }, "looking ahead: two missed days, one rest day: over");
eq(RM.streakOn(run(30), T, true), { streak: 30, restBank: 2 }, "30 days: 2 rest days saved at most");
eq(RM.streakOn(new Set(run(3)), T, true).streak, 3, "takes a Set too");

/* the words name the streak */
eq(RM.message({ streak: 12, todayMin: 0, minQ: 5 }), { title: "Keep your 12-day streak going", body: "Nothing logged yet today. 5 minutes keeps it alive." }, "12-day streak");
eq(RM.message({ streak: 1, todayMin: 0, minQ: 1 }), { title: "Keep your 1-day streak going", body: "Nothing logged yet today. 1 minute keeps it alive." }, "1-day streak, 1 minute");
eq(RM.message({ streak: 12, todayMin: 2, minQ: 5 }).body, "You've logged 2 minutes today. 3 more and today counts.", "some time logged, not enough to count");
eq(RM.message({ streak: 12, todayMin: 0, minQ: 5, restBank: 1 }).body, "Nothing logged yet today. 5 minutes keeps it going without using a rest day.", "a rest day is saved");
eq(RM.message({ streak: 0, todayMin: 0, minQ: 5 }), { title: "Start a new streak today", body: "Log 5 minutes of listening and day one is yours." }, "no streak");
eq(RM.message({ streak: 0, todayMin: 1, minQ: 5 }).body, "You've logged 1 minute today. 4 more and day one is yours.", "no streak, some time logged");
ok(!/undefined|NaN/.test(JSON.stringify(RM.message())), "no arguments: still clean words");

/* is today's reminder due? */
ok(!RM.due({ on: false, time: "20:00" }, at(T, 21), 0, 5), "off: never due");
ok(!RM.due(ON, at(T, 19, 59), 0, 5), "7:59 PM: not yet");
ok(RM.due(ON, at(T, 20, 0), 0, 5), "8:00 PM, nothing logged: due");
ok(RM.due(ON, at(T, 23, 59), 0, 5), "11:59 PM, nothing logged: still due (the app was opened late)");
ok(!RM.due(ON, at(RM.addDays(T, 1), 0, 1), 0, 5), "12:01 AM the next day: yesterday's is gone, today's isn't due yet");
ok(!RM.due(ON, at(T, 21), 5, 5), "today already counts toward the streak: no reminder");
ok(!RM.due(ON, at(T, 21), 240, 5), "4 hours logged today: no reminder");
ok(RM.due(ON, at(T, 21), 2, 5), "2 minutes logged but 5 needed: the streak isn't safe, so it is due");
ok(!RM.due({ ...ON, lastDay: T }, at(T, 21), 0, 5), "already reminded today: not again");
ok(RM.due({ ...ON, lastDay: back(1) }, at(T, 21), 0, 5), "reminded yesterday: due today");
ok(!RM.due({ ...ON, time: "22:00", lastDay: T }, at(T, 22, 30), 0, 5), "one a day: moving the time later after today's reminder doesn't bring a second one");
ok(!RM.due({ ...ON, since: at(T, 21).getTime() }, at(T, 21, 5), 0, 5), "turned on at 9 PM with an 8 PM time: nothing pops up tonight");
ok(RM.due({ ...ON, since: at(T, 21).getTime() }, at(RM.addDays(T, 1), 20), 0, 5), "and it is due at 8 PM the next day");
ok(RM.due({ ...ON, time: "22:00", since: at(T, 21).getTime() }, at(T, 22), 0, 5), "turned on at 9 PM, time moved to 10 PM: due at 10 PM tonight");
ok(RM.due({ on: true, time: "00:00" }, at(T, 0, 0), 0, 5), "a midnight time is due from the first minute of the day");
ok(RM.due({ on: true }, at(T, 20), 0, 5) && !RM.due({ on: true }, at(T, 19, 59), 0, 5), "no time saved: 8:00 PM is the default");

/* the Home card */
ok(RM.cardOn(ON, at(T, 20, 30), 0, 5), "after the time with nothing logged: the card shows");
ok(RM.cardOn({ ...ON, lastDay: T }, at(T, 20, 30), 0, 5), "it stays after the notification was shown");
ok(!RM.cardOn({ ...ON, hideDay: T }, at(T, 20, 30), 0, 5), "dismissed today: gone");
ok(RM.cardOn({ ...ON, hideDay: back(1) }, at(T, 20, 30), 0, 5), "dismissed yesterday: back today");
ok(!RM.cardOn(ON, at(T, 19), 0, 5) && !RM.cardOn(ON, at(T, 21), 5, 5) && !RM.cardOn({ on: false }, at(T, 21), 0, 5), "not before the time, not once today counts, not when off");

/* when to look again */
eq(RM.nextCheck(ON, at(T, 10)).getTime(), at(T, 20).getTime(), "morning: look again at 8 PM today");
eq(RM.nextCheck(ON, at(T, 20)).getTime(), at(RM.addDays(T, 1), 20).getTime(), "at 8 PM: next is 8 PM tomorrow");
eq(RM.nextCheck(ON, at("2026-03-07", 21)).getHours(), 20, "across spring forward it is still 8 PM local");
eq(RM.nextCheck(ON, at("2026-10-31", 21)).getHours(), 20, "across fall back it is still 8 PM local");

/* the plan for a closed app */
{ const base = { prefs: ON, now: at(T, 10), minQ: 5, todayMin: 0 };
  eq(RM.plan({ ...base, prefs: { on: false } }), [], "off: an empty plan");
  let p = RM.plan({ ...base, qualDays: run(12), restOn: false });
  eq(p.length, 7, "seven days ahead"); eq(p.map(e => e.day), Array.from({ length: 7 }, (_, i) => RM.addDays(T, i)), "today and the next six days");
  eq([p[0].title, p[0].streak], ["Keep your 12-day streak going", 12], "today's entry names the 12-day streak");
  eq([p[1].title, p[1].streak], ["Start a new streak today", 0], "tomorrow, if today is missed with rest days off, it is a new streak");
  ok(p.every(e => e.time === "20:00"), "every entry carries the reminder time");
  p = RM.plan({ ...base, qualDays: run(12), restOn: true });
  eq(p.slice(0, 3).map(e => e.streak), [12, 12, 0], "rest days on: the saved rest day keeps it one more day, then it ends");
  ok(/without using a rest day/.test(p[0].body) && !/rest day/.test(p[1].body), "the rest-day wording only while one is saved");
  p = RM.plan({ ...base, qualDays: [T, ...run(12)], todayMin: 30, restOn: false });
  eq([p.length, p[0].day, p[0].title], [6, RM.addDays(T, 1), "Keep your 13-day streak going"], "today already counts: no entry today, tomorrow names 13 days");
  p = RM.plan({ ...base, qualDays: [T, ...run(12)], todayMin: 2, restOn: false });
  eq([p[0].day, p[0].streak, p[0].body], [T, 12, "You've logged 2 minutes today. 3 more and today counts."], "2 of 5 minutes today: today is still planned, and not counted as a streak day");
  p = RM.plan({ ...base, prefs: { ...ON, lastDay: T }, qualDays: run(12), restOn: false });
  eq(p[0].day, RM.addDays(T, 1), "already reminded today: the plan starts tomorrow");
  p = RM.plan({ ...base, now: at(T, 21), prefs: { ...ON, since: at(T, 21).getTime() }, qualDays: run(12), restOn: false });
  eq(p[0].day, RM.addDays(T, 1), "turned on after tonight's time: the plan starts tomorrow");
  p = RM.plan({ ...base, prefs: { on: true, time: "07:15" }, qualDays: [], horizon: 2 });
  eq(p.map(e => [e.day, e.time, e.title]), [[T, "07:15", "Start a new streak today"], [RM.addDays(T, 1), "07:15", "Start a new streak today"]], "a new listener, a 7:15 AM time");
}

/* the service worker's choice from a plan, and that sw.js and index.html agree */
{ const plan = RM.plan({ prefs: ON, now: at(T, 10), qualDays: run(12), todayMin: 0, minQ: 5, restOn: false }), tom = RM.addDays(T, 1);
  eq(RM.pick(plan, at(T, 19, 59), null), null, "before the time: nothing");
  eq(RM.pick(plan, at(T, 20), null).day, T, "at the time: today's entry");
  eq(RM.pick(plan, at(T, 23, 59), null).day, T, "late the same day: still today's");
  eq(RM.pick(plan, at(tom, 0, 0), null), null, "after midnight: yesterday's has expired, tomorrow's isn't due");
  eq(RM.pick(plan, at(T, 21), T), null, "already shown today: nothing");
  eq(RM.pick(plan, at(tom, 20, 5), T).title, "Start a new streak today", "the next day's entry when its time comes");
  eq(RM.pick(plan, at(RM.addDays(T, 7), 21), null), null, "past the end of the plan: nothing, reminders rest until the app is opened");
  eq(RM.pick([null, {}, { day: "soon", time: "20:00" }, 7], at(T, 21), null), null, "a damaged plan: nothing");
  eq(RM.pick(null, at(T, 21), null), null, "no plan: nothing");
  let diff = 0, n = 0;
  for (const p of [plan, plan.slice(1), [{ day: T, time: "00:00", title: "a" }], [{ day: T, time: "23:59", title: "b" }], [{ day: T }], [null, { day: "x" }], null])
    for (let d = -1; d <= 8; d++) for (const [h, mi] of [[0, 0], [0, 1], [7, 15], [19, 59], [20, 0], [20, 1], [23, 59]])
      for (const shown of [null, T, tom]) { n++; const now = at(RM.addDays(T, d), h, mi); if (JSON.stringify(RM.pick(p, now, shown)) !== JSON.stringify(remPick(p, now, shown))) diff++; }
  eq(diff, 0, `sw.js remPick gives the same answer as RM.pick (${n} cases)`);
}

console.log(`${fail ? "FAIL" : "PASS"}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
